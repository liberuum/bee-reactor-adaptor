/**
 * Chat History — ACT-encrypted persistent message log with feed-indexed pagination.
 *
 * Each feed entry is a PAGE: a small batch of messages written together
 * (usually 1-5 messages per batch — flushed after a 3s debounce).
 *
 * Feed indices give us natural pagination:
 *   - Latest page = highest feed index (read via downloadReference())
 *   - Older pages = N-1, N-2, ... (read via downloadReference({ index }))
 *
 * Each user writes their own sent messages to their own feed. To reconstruct
 * a conversation, both peers read both feeds in parallel, merge, dedupe.
 */
import { Topic, FeedIndex } from "@ethersphere/bee-js";
import type { SwarmClient } from "../swarm-client.js";
import type { ChatMessage } from "./types.js";

const HISTORY_TOPIC_PREFIX = "ph:v2:chatlog:";

/**
 * Size of a feed payload that indirects to `{ actRef, actHist }`.
 *
 * The feed stores a 32-byte reference to a small plaintext /bytes chunk
 * (the "wrapper"). The wrapper is exactly 64 bytes: the first 32 are the
 * ACT-protected page's reference, the last 32 are its actHistoryAddress.
 * On read we need both to decrypt — persisting them together in a single
 * indirection keeps each page self-describing, without bloating the feed
 * payload beyond the 32-byte convention used everywhere else.
 *
 * Wrapper contents are references (public-by-nature). Nothing sensitive
 * lands in plaintext — the ACT grant is what actually protects the page.
 */
const WRAPPER_BYTES = 64;

function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "");
  if (clean.length !== 64) {
    throw new Error(`expected 32-byte hex, got length ${clean.length}`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytes32ToHex(bytes: Uint8Array, offset = 0): string {
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += bytes[offset + i].toString(16).padStart(2, "0");
  }
  return out;
}


/**
 * Derive a deterministic feed topic for chat history.
 * Sorting ensures both parties use the same topic (but different owners).
 */
export function historyTopic(
  addressA: string,
  addressB: string,
  chapter = 0,
): string {
  const sorted = [addressA.toLowerCase(), addressB.toLowerCase()].sort();
  const base = `${HISTORY_TOPIC_PREFIX}${sorted[0]}:${sorted[1]}`;
  // Chapter 0 omits the suffix so legacy readers continue to see the
  // same topic. Any "clear chats" action increments the writer's
  // chapter, starting a brand-new feed. Both directions are tracked
  // independently (see chapterStore below) — I control my write
  // chapter; I learn the peer's chapter from PSS announcements.
  return chapter > 0 ? `${base}:${chapter}` : base;
}

// ─── Chapter store (per-browser localStorage) ─────────────────────

const MY_CHAPTER_KEY = "swarm:chatMyChapter";
const PEER_CHAPTERS_KEY = "swarm:chatPeerChapters";

function readNumber(raw: string | null): number {
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function getMyChatChapter(): number {
  try {
    return readNumber((globalThis as any).window?.localStorage?.getItem?.(MY_CHAPTER_KEY) ?? null);
  } catch {
    return 0;
  }
}

export function bumpMyChatChapter(): number {
  // Chapter value uses Date.now() (ms) instead of a simple counter so
  // it stays monotonic across localStorage wipes. If the user clears
  // browser storage entirely then clicks "Clear all chats" again, a
  // naive counter restarts at 1 and collides with the chapter-1 feed
  // they already wrote to earlier in the day — reviving old messages.
  // Date.now() is always larger than any previously-used value, so we
  // land on a brand-new feed no matter what came before.
  //
  // Math.max with (prev + 1) guards against system-clock drift: if the
  // clock ever rolls backward we still get a strictly-increasing value.
  const prev = getMyChatChapter();
  const next = Math.max(prev + 1, Date.now());
  try {
    (globalThis as any).window?.localStorage?.setItem?.(MY_CHAPTER_KEY, String(next));
  } catch { /* localStorage unavailable */ }
  return next;
}

export function getPeerChatChapter(peerAddress: string): number {
  try {
    const raw = (globalThis as any).window?.localStorage?.getItem?.(PEER_CHAPTERS_KEY);
    if (!raw) return 0;
    const map = JSON.parse(raw) as Record<string, number>;
    const v = map[peerAddress.toLowerCase()];
    return typeof v === "number" && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

/** Record a chapter we learned from an incoming PSS message. Only ever
 *  increases — we never move peer's chapter backwards. */
export function recordPeerChatChapter(peerAddress: string, chapter: number): void {
  if (!Number.isFinite(chapter) || chapter <= 0) return;
  try {
    const ls = (globalThis as any).window?.localStorage;
    if (!ls) return;
    const raw = ls.getItem(PEER_CHAPTERS_KEY);
    const map = (raw ? JSON.parse(raw) : {}) as Record<string, number>;
    const key = peerAddress.toLowerCase();
    const cur = map[key] ?? 0;
    if (chapter > cur) {
      map[key] = chapter;
      ls.setItem(PEER_CHAPTERS_KEY, JSON.stringify(map));
    }
  } catch { /* localStorage unavailable */ }
}

/** A single feed-indexed page of messages */
interface HistoryPage {
  messages: ChatMessage[];
  writtenAt: string;
}

/** Cursor state for backward pagination per feed owner */
export interface FeedCursor {
  /** Next feed index to load (decrements on each load). null = no more */
  nextIndex: number | null;
}

/** Combined cursor for a conversation — tracks both feeds */
export interface HistoryCursor {
  mine: FeedCursor;
  peer: FeedCursor;
}

export interface LoadedHistory {
  messages: ChatMessage[];
  cursor: HistoryCursor;
  /** true if at least one feed has more pages to load */
  hasMore: boolean;
}

export class ChatHistory {
  /** Cached grantee info per peer (create once, reuse for all writes) */
  private granteeCache = new Map<string, { granteeRef: string; granteeHistRef: string }>();

  constructor(
    private readonly client: SwarmClient,
    private readonly myAddress: string,
  ) {}

  // ─── Write side ───────────────────────────────────────────────

  /**
   * Write a batch of new messages as a new feed entry.
   * Each call creates a new feed index (one page).
   *
   * @param peerAddress - Peer's Swarm signer address (for topic + grant)
   * @param messages - Batch of new messages to write (usually 1-5)
   * @param peerBeeNodePubKey - Peer's Bee pubkey for ACT grant
   */
  async writePage(
    peerAddress: string,
    messages: ChatMessage[],
    peerBeeNodePubKey: string,
  ): Promise<void> {
    if (messages.length === 0) return;

    // Ensure grantees exist (cached per peer)
    let grantees = this.granteeCache.get(peerAddress);
    if (!grantees) {
      const myBeeNodePubKey = await this.client.getBeeNodePublicKey();
      const { ref: granteeRef, historyRef: granteeHistRef } =
        await this.client.createGrantees([peerBeeNodePubKey, myBeeNodePubKey]);
      grantees = { granteeRef, granteeHistRef };
      this.granteeCache.set(peerAddress, grantees);
      await new Promise(r => setTimeout(r, 1100)); // ACT 1s rule
    }

    const page: HistoryPage = {
      messages,
      writtenAt: new Date().toISOString(),
    };

    // Upload ACT-protected page. Capture BOTH the content reference and
    // the ACT historyAddress — the latter is what downstream readers need
    // alongside actPublisher to decrypt. bee-js returns the current head
    // of the ACT grant chain; this can equal granteeHistRef (no rotation)
    // or extend it (if grantees changed since last upload).
    const { reference: actRef, historyAddress } = await this.client.uploadFile(
      JSON.stringify(page),
      {
        act: true,
        actHistoryAddress: grantees.granteeHistRef,
        skipEncryption: true,
      },
    );
    const actHist = historyAddress ?? grantees.granteeHistRef;

    // Pack `{ actRef, actHist }` into a 64-byte wrapper and upload via
    // /bytes. We write the WRAPPER's 32-byte reference to the feed, so
    // the feed payload stays at the 32-byte convention used elsewhere.
    // See WRAPPER_BYTES doc for the rationale.
    const wrapper = new Uint8Array(WRAPPER_BYTES);
    wrapper.set(hexToBytes32(actRef), 0);
    wrapper.set(hexToBytes32(actHist), 32);
    const { reference: wrapperRef } = await this.client.uploadData(wrapper, {
      skipEncryption: true,
    });

    // Write the wrapper's reference as the feed entry. Topic is
    // namespaced by MY current chapter — bumping the chapter (via
    // "Clear all chats") switches future writes to a brand-new feed,
    // leaving old messages orphaned on Swarm until their stamps expire.
    const topic = Topic.fromString(
      historyTopic(this.myAddress, peerAddress, getMyChatChapter()),
    );
    await this.client.writeFeedPayload(topic, wrapperRef);
  }

  // ─── Read side ────────────────────────────────────────────────

  /**
   * Load the latest N pages from a feed owner.
   *
   * The feed TOPIC is always the sorted-pair topic derived from (my, peer) —
   * symmetric, same on both sides. Only the feed OWNER differs: my own feed
   * is owned by me (stores messages I sent), peer's feed is owned by peer
   * (stores messages they sent). A previous version of this function used
   * `historyTopic(myAddress, feedOwner)` which produced a self-self topic
   * when reading my own feed, so recovery always 404'd on it — writes went
   * to the pair topic, reads looked up a different topic that never existed.
   */
  async loadLatestPages(
    feedOwner: string,
    peerAddress: string,
    publisherBeeNodePubKey: string,
    pageCount: number,
  ): Promise<{ messages: ChatMessage[]; cursor: FeedCursor }> {
    // Chapter resolution per feed owner:
    //   Mine  → my current chapter (straightforward).
    //   Peer  → max(recorded peer chapter, my chapter).
    //
    // The max() for peer is the key post-clear behavior: if I've bumped
    // my chapter via "Clear all chats" but peer hasn't rotated yet,
    // their recorded chapter is still behind mine. We look for their
    // feed at my chapter — a feed they haven't written to yet — which
    // correctly returns empty. This prevents peer's pre-clear history
    // from resurfacing just because they haven't cleared their side.
    // When peer eventually sends a message carrying a chapter >= mine,
    // recordPeerChatChapter updates our recording, and subsequent reads
    // find their new feed.
    const myChapter = getMyChatChapter();
    const isMine = feedOwner.toLowerCase() === this.myAddress.toLowerCase();
    const chapter = isMine
      ? myChapter
      : Math.max(getPeerChatChapter(peerAddress), myChapter);
    const topic = Topic.fromString(historyTopic(this.myAddress, peerAddress, chapter));
    const ownerNormalized = feedOwner.replace(/^0x/i, "").toLowerCase();

    // Step 1: Get the latest feed index
    const latestIndex = await this.getLatestFeedIndex(topic, ownerNormalized);
    if (latestIndex === null) {
      return { messages: [], cursor: { nextIndex: null } };
    }

    // Step 2: Load N pages going backwards from latestIndex
    return this.loadPages(topic, ownerNormalized, publisherBeeNodePubKey, latestIndex, pageCount);
  }

  /**
   * Load older pages starting from a cursor (continuation from previous load).
   */
  async loadOlderPages(
    feedOwner: string,
    peerAddress: string,
    publisherBeeNodePubKey: string,
    cursor: FeedCursor,
    pageCount: number,
  ): Promise<{ messages: ChatMessage[]; cursor: FeedCursor }> {
    if (cursor.nextIndex === null) {
      return { messages: [], cursor: { nextIndex: null } };
    }
    const isMine = feedOwner.toLowerCase() === this.myAddress.toLowerCase();
    const chapter = isMine ? getMyChatChapter() : getPeerChatChapter(peerAddress);
    const topic = Topic.fromString(historyTopic(this.myAddress, peerAddress, chapter));
    const ownerNormalized = feedOwner.replace(/^0x/i, "").toLowerCase();
    return this.loadPages(topic, ownerNormalized, publisherBeeNodePubKey, cursor.nextIndex, pageCount);
  }

  /**
   * Load a full conversation (merge both feeds) starting from latest.
   * Convenience wrapper used on initial load.
   */
  async loadConversationLatest(
    peerAddress: string,
    myBeeNodePubKey: string,
    peerBeeNodePubKey: string,
    pageCount: number,
  ): Promise<LoadedHistory> {
    const [mine, peer] = await Promise.all([
      this.loadLatestPages(this.myAddress, peerAddress, myBeeNodePubKey, pageCount),
      this.loadLatestPages(peerAddress, peerAddress, peerBeeNodePubKey, pageCount),
    ]);

    const merged = this.mergeAndSort([...mine.messages, ...peer.messages]);
    return {
      messages: merged,
      cursor: { mine: mine.cursor, peer: peer.cursor },
      hasMore: mine.cursor.nextIndex !== null || peer.cursor.nextIndex !== null,
    };
  }

  /**
   * Load more (older) pages from a conversation using a cursor.
   */
  async loadConversationOlder(
    peerAddress: string,
    myBeeNodePubKey: string,
    peerBeeNodePubKey: string,
    cursor: HistoryCursor,
    pageCount: number,
  ): Promise<LoadedHistory> {
    const [mine, peer] = await Promise.all([
      this.loadOlderPages(this.myAddress, peerAddress, myBeeNodePubKey, cursor.mine, pageCount),
      this.loadOlderPages(peerAddress, peerAddress, peerBeeNodePubKey, cursor.peer, pageCount),
    ]);

    const merged = this.mergeAndSort([...mine.messages, ...peer.messages]);
    return {
      messages: merged,
      cursor: { mine: mine.cursor, peer: peer.cursor },
      hasMore: mine.cursor.nextIndex !== null || peer.cursor.nextIndex !== null,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────

  /** Get the latest feed index (returns null if feed doesn't exist) */
  private async getLatestFeedIndex(topic: Topic, owner: string): Promise<number | null> {
    try {
      const reader = (this.client as any).bee.makeFeedReader(topic, owner);
      const result = await reader.downloadReference();
      // result.feedIndex is a FeedIndex (hex string of 8-byte big-endian integer)
      return this.parseFeedIndex(result.feedIndex);
    } catch {
      return null;
    }
  }

  /** Load a range of pages going backwards from startIndex */
  private async loadPages(
    topic: Topic,
    owner: string,
    publisherBeeNodePubKey: string,
    startIndex: number,
    pageCount: number,
  ): Promise<{ messages: ChatMessage[]; cursor: FeedCursor }> {
    const reader = (this.client as any).bee.makeFeedReader(topic, owner);
    const messages: ChatMessage[] = [];
    let currentIndex = startIndex;
    let loaded = 0;

    while (loaded < pageCount && currentIndex >= 0) {
      // Three distinct failure modes:
      //   1) downloadReference throws → feed boundary. Break.
      //   2) wrapper chunk unavailable / wrong size → legacy entry or
      //      chunk not propagated. Skip this index, keep walking.
      //   3) page download throws (ACT decrypt / missing /bzz) → same,
      //      skip and keep walking. Older pages may still be retrievable.
      let wrapperRef: string;
      try {
        const feedIndex = FeedIndex.fromBigInt(BigInt(currentIndex));
        const result = await reader.downloadReference({ index: feedIndex });
        wrapperRef = result.reference.toHex();
      } catch {
        break; // case 1 — feed boundary
      }

      try {
        const wrapperBytes = await this.client.downloadData(wrapperRef, {
          skipDecryption: true,
        });
        if (wrapperBytes.length !== WRAPPER_BYTES) {
          // Case 2 — legacy feed entry from before the wrapper format
          // (bare 32-byte actRef with no hist). We can't decrypt without
          // actHistoryAddress, so skip. Users who have only legacy entries
          // will see empty recovery; newly-sent messages use the wrapper.
          currentIndex--;
          continue;
        }
        const actRef = bytes32ToHex(wrapperBytes, 0);
        const actHist = bytes32ToHex(wrapperBytes, 32);

        const data = await this.client.downloadFile(actRef, {
          actPublisher: publisherBeeNodePubKey,
          actHistoryAddress: actHist,
          skipDecryption: true,
        });
        const page = JSON.parse(new TextDecoder().decode(data)) as HistoryPage;
        if (Array.isArray(page.messages)) {
          messages.push(...page.messages);
        }
        loaded++;
      } catch {
        // Case 3 — page or wrapper unavailable; keep walking.
      }
      currentIndex--;
    }

    return {
      messages,
      cursor: { nextIndex: currentIndex >= 0 ? currentIndex : null },
    };
  }

  private mergeAndSort(messages: ChatMessage[]): ChatMessage[] {
    const byId = new Map<string, ChatMessage>();
    for (const m of messages) {
      if (!byId.has(m.id)) byId.set(m.id, m);
    }
    return [...byId.values()].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }

  /** Parse a FeedIndex (hex string) to a number. */
  private parseFeedIndex(idx: unknown): number | null {
    try {
      if (idx === null || idx === undefined) return null;
      // Try toBigInt() method (bee-js FeedIndex)
      if (typeof (idx as any).toBigInt === "function") {
        return Number((idx as any).toBigInt());
      }
      // Fallback: parse hex string
      if (typeof idx === "string") return parseInt(idx, 16);
      if (typeof idx === "number") return idx;
      return null;
    } catch {
      return null;
    }
  }
}
