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
 * Derive a deterministic feed topic for chat history.
 * Sorting ensures both parties use the same topic (but different owners).
 */
export function historyTopic(addressA: string, addressB: string): string {
  const sorted = [addressA.toLowerCase(), addressB.toLowerCase()].sort();
  return `${HISTORY_TOPIC_PREFIX}${sorted[0]}:${sorted[1]}`;
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

    // Upload ACT-protected page
    const { reference } = await this.client.uploadFile(
      JSON.stringify(page),
      {
        act: true,
        actHistoryAddress: grantees.granteeHistRef,
        skipEncryption: true,
      },
    );

    // Write as a new feed entry (feed index auto-increments)
    const topic = Topic.fromString(historyTopic(this.myAddress, peerAddress));
    await this.client.writeFeedPayload(topic, reference);
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
    const topic = Topic.fromString(historyTopic(this.myAddress, peerAddress));
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
    const topic = Topic.fromString(historyTopic(this.myAddress, peerAddress));
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
      // Two distinct failure modes here — treating them the same way is
      // what caused recovery to stall on bad pages:
      //   1) downloadReference throws → feed boundary reached (no index
      //      at or below currentIndex exists). Correct to break.
      //   2) downloadFile throws → feed index exists but the /bzz chunk
      //      isn't retrievable (sender hasn't propagated, ACT grant
      //      missing, 2.7.x Bee can't fetch yet). Skip the page and keep
      //      walking — older pages may still be retrievable.
      let ref: string;
      try {
        const feedIndex = FeedIndex.fromBigInt(BigInt(currentIndex));
        const result = await reader.downloadReference({ index: feedIndex });
        ref = result.reference.toHex();
      } catch {
        break; // case 1 — feed boundary
      }

      try {
        const data = await this.client.downloadFile(ref, {
          actPublisher: publisherBeeNodePubKey,
          skipDecryption: true,
        });
        const page = JSON.parse(new TextDecoder().decode(data)) as HistoryPage;
        if (Array.isArray(page.messages)) {
          messages.push(...page.messages);
        }
        loaded++;
      } catch {
        // case 2 — page unavailable, don't count it but keep walking
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
