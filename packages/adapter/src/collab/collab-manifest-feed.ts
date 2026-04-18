/**
 * CollabManifestFeed — mutable source of truth for who's in a collab.
 *
 * Owned by the collab initiator. Each feed update points to an
 * ACT-protected JSON describing the current participant list. The feed
 * keeps its history so a participant who comes online after a revocation
 * can tell whether they were ever a member (some old index they could
 * read) vs whether they're still a member (the current index they can or
 * cannot read).
 *
 * Revocation strategy
 * -------------------
 *   - Initiator calls createGrantees with the SHORTER list, producing a new
 *     (granteeRef, granteeHistRef) pair. The removed peer's Bee pubkey is
 *     absent from the new chain.
 *   - Initiator writes a fresh manifest entry under the new chain. Future
 *     op-feed writes from any participant also use this chain (the manager
 *     pulls latest grantees on every appendBatch).
 *   - Content previously visible to the removed peer stays visible to them
 *     — ACT has no unbaking. The removal only blocks future decryption.
 */

import { Topic, FeedIndex } from "@ethersphere/bee-js";
import type { SwarmClient } from "../swarm-client.js";
import type { CollabId, CollabManifest } from "./types.js";
import { collabManifestTopic } from "./types.js";

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

function parseFeedIndex(raw: unknown): number {
  if (raw == null) return 0;
  if (typeof raw === "number") return raw;
  // bee-js's FeedIndex instances expose `.toBigInt()` in newer builds.
  if (typeof raw === "object" && raw !== null && typeof (raw as any).toBigInt === "function") {
    try { return Number((raw as any).toBigInt()); } catch { /* fall through */ }
  }
  // Older / non-FeedIndex objects may have a string representation.
  const asString = typeof raw === "string" ? raw : String(raw);
  const hex = asString.startsWith("0x") ? asString.slice(2) : asString;
  if (!/^[0-9a-f]+$/i.test(hex)) return 0;
  try {
    return Number(BigInt("0x" + hex));
  } catch {
    return 0;
  }
}

export class CollabManifestFeed {
  /** Last index we wrote per topic. Lets publish() return a correct
   *  feedIndex even when Bee's post-write feed reads are still showing
   *  stale state (which we hit against public nodes). */
  private lastWrittenIndex = new Map<string, number>();

  constructor(private readonly client: SwarmClient) {}

  static topicFor(collabId: CollabId): Topic {
    return Topic.fromString(collabManifestTopic(collabId));
  }

  /**
   * Publish a manifest revision. Caller supplies the grantee set; this
   * class just writes. Rotation (shrinking the grantee list for
   * revocation) is the caller's responsibility: pass a fresh
   * granteeHistRef when the participants change.
   */
  async publish(
    manifest: CollabManifest,
    granteeHistRef: string,
  ): Promise<{ feedIndex: number; actRef: string; actHistoryAddress: string }> {
    const topic = CollabManifestFeed.topicFor(manifest.collabId);
    const topicHex = topic.toHex();
    const ownerAddress = this.client.getOwnerAddress();

    // Work out which index this write lands at. Prefer a local counter
    // (per-topic, seeded from Swarm on first access) because Bee's
    // immediate post-write reads are eventually-consistent on public
    // networks — we hit repeated feedIndex: 0 readbacks in integration.
    let nextIndex = this.lastWrittenIndex.get(topicHex);
    if (nextIndex === undefined) {
      const readerPre = (this.client as any).bee.makeFeedReader(topic, ownerAddress);
      try {
        const head = await readerPre.downloadReference();
        // head.feedIndex = current latest. Next write lands at +1.
        // Some bee-js builds also expose feedIndexNext which is the same
        // thing precomputed — prefer it when present.
        nextIndex =
          head?.feedIndexNext !== undefined
            ? parseFeedIndex(head.feedIndexNext)
            : parseFeedIndex(head.feedIndex) + 1;
      } catch {
        // Brand-new feed — our write lands at index 0.
        nextIndex = 0;
      }
    } else {
      nextIndex = nextIndex + 1;
    }

    const { reference: actRef, historyAddress } = await this.client.uploadFile(
      JSON.stringify(manifest),
      {
        act: true,
        actHistoryAddress: granteeHistRef,
        skipEncryption: true,
      },
    );
    const actHist = historyAddress ?? granteeHistRef;

    // Wrap (actRef || actHist) into a 64-byte chunk so readers can
    // reconstruct the full decryption context from the feed alone.
    const wrapper = new Uint8Array(WRAPPER_BYTES);
    wrapper.set(hexToBytes32(actRef), 0);
    wrapper.set(hexToBytes32(actHist), 32);
    const { reference: wrapperRef } = await this.client.uploadData(wrapper, {
      skipEncryption: true,
    });

    // Write at the explicit index we decided above. bee-js's auto-pick
    // uses its own pre-read which is stale on public nodes — passing the
    // index ourselves keeps the counter consistent.
    await this.client.writeFeedPayloadAtIndex(topic, wrapperRef, nextIndex);
    this.lastWrittenIndex.set(topicHex, nextIndex);

    return { feedIndex: nextIndex, actRef, actHistoryAddress: actHist };
  }

  /**
   * Read the latest manifest revision, or null if the feed doesn't exist
   * or the chunk hasn't propagated to this node yet.
   *
   * @param readerBeeNodePubKey — the initiator's Bee node pubkey. Needed
   *    as `actPublisher` for ACT decrypt.
   */
  async readLatest(
    collabId: CollabId,
    ownerSignerAddress: string,
    readerBeeNodePubKey: string,
  ): Promise<{ manifest: CollabManifest; feedIndex: number } | null> {
    const topic = CollabManifestFeed.topicFor(collabId);
    const reader = (this.client as any).bee.makeFeedReader(topic, ownerSignerAddress);
    let wrapperRef: string;
    let feedIndex = 0;
    try {
      const result = await reader.downloadReference();
      wrapperRef = result.reference.toHex();
      feedIndex = parseFeedIndex(result.feedIndex);
      // Bee's "latest" feed lookup (downloadReference with no args) can
      // return a stale entry when multiple updates land in quick
      // succession — the feedIndexNext header still correctly advances,
      // so if next > feedIndex+1 we know the real latest is elsewhere
      // and re-fetch by explicit index.
      if (result.feedIndexNext !== undefined) {
        const nextIdx = parseFeedIndex(result.feedIndexNext);
        if (nextIdx > feedIndex + 1) {
          const realLatest = nextIdx - 1;
          const m = await this.readAtIndex(
            collabId,
            ownerSignerAddress,
            readerBeeNodePubKey,
            realLatest,
          );
          if (m) return { manifest: m, feedIndex: realLatest };
          // Fall through to use the first-returned entry if the explicit
          // lookup for the real latest fails (chunk not propagated).
          feedIndex = realLatest;
        }
      }
    } catch {
      return null;
    }

    try {
      const wrapperBytes = await this.client.downloadData(wrapperRef, {
        skipDecryption: true,
      });
      if (wrapperBytes.length !== WRAPPER_BYTES) return null;
      const actRef = bytes32ToHex(wrapperBytes, 0);
      const actHist = bytes32ToHex(wrapperBytes, 32);
      const data = await this.client.downloadFile(actRef, {
        actPublisher: readerBeeNodePubKey,
        actHistoryAddress: actHist,
        skipDecryption: true,
      });
      const manifest = JSON.parse(new TextDecoder().decode(data)) as CollabManifest;
      return { manifest, feedIndex };
    } catch {
      return null;
    }
  }

  /**
   * Read a specific feed index, if accessible. Used by participants who
   * were revoked after index N — they can still read up to N via
   * feedIndex lookups.
   */
  async readAtIndex(
    collabId: CollabId,
    ownerSignerAddress: string,
    readerBeeNodePubKey: string,
    index: number,
  ): Promise<CollabManifest | null> {
    const topic = CollabManifestFeed.topicFor(collabId);
    const reader = (this.client as any).bee.makeFeedReader(topic, ownerSignerAddress);
    let wrapperRef: string;
    try {
      const result = await reader.downloadReference({
        index: FeedIndex.fromBigInt(BigInt(index)),
      });
      wrapperRef = result.reference.toHex();
    } catch {
      return null;
    }

    try {
      const wrapperBytes = await this.client.downloadData(wrapperRef, {
        skipDecryption: true,
      });
      if (wrapperBytes.length !== WRAPPER_BYTES) return null;
      const actRef = bytes32ToHex(wrapperBytes, 0);
      const actHist = bytes32ToHex(wrapperBytes, 32);
      const data = await this.client.downloadFile(actRef, {
        actPublisher: readerBeeNodePubKey,
        actHistoryAddress: actHist,
        skipDecryption: true,
      });
      return JSON.parse(new TextDecoder().decode(data)) as CollabManifest;
    } catch {
      return null;
    }
  }
}
