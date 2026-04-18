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
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return 0;
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  try {
    return Number(BigInt("0x" + hex));
  } catch {
    return 0;
  }
}

export class CollabManifestFeed {
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

    const topic = CollabManifestFeed.topicFor(manifest.collabId);
    await this.client.writeFeedPayload(topic, wrapperRef);

    // Read back the index we just wrote so callers can record it.
    const reader = (this.client as any).bee.makeFeedReader(
      topic,
      // Owner = current signer (initiator).
      this.client.getOwnerAddress(),
    );
    let feedIndex = 0;
    try {
      const result = await reader.downloadReference();
      feedIndex = parseFeedIndex(result.feedIndex);
    } catch {
      /* brand-new feed — default to 0 */
    }
    return { feedIndex, actRef, actHistoryAddress: actHist };
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
