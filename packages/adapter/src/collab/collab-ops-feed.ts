/**
 * CollabOpsFeed — ACT-protected per-peer operation feed for live collaboration.
 *
 * Each participant writes their OWN ops to their OWN feed. The feed topic is
 * scoped by collabId + driveId + docId; the feed OWNER is the writer's Swarm
 * signer address. Every other participant's Bee node pubkey is an ACT grantee
 * so peers can decrypt each other's ops (the inviter's non-participant
 * personal feeds stay wallet-key encrypted and untouched).
 *
 * Feed layout (one append per op batch):
 *
 *   feed index 0 ─┐
 *   feed index 1 ─┼─► 32-byte ref to a 64-byte wrapper chunk on /bytes
 *   feed index 2 ─┘        │
 *                          ├── bytes 0..31: actRef     (ACT-protected batch payload on /bzz)
 *                          └── bytes 32..63: actHist   (ACT chain head)
 *
 * The wrapper chunk mirrors the pattern used by chat-history.ts so peers can
 * reconstruct the full ACT decryption context from the feed alone, with no
 * side-channel state.
 *
 * Batch payload format (after ACT decrypt):
 *   { opsJson: string, startIndex: number, endIndex: number, scope: string, branch: string, timestamp: string }
 */

import { Topic, FeedIndex } from "@ethersphere/bee-js";
import type { SwarmClient } from "../swarm-client.js";
import type { CollabId } from "./types.js";
import { collabDocOpsTopic, collabDriveOpsTopic } from "./types.js";

const WRAPPER_BYTES = 64;

export interface CollabOpsBatch {
  /** Raw op array serialized to JSON. */
  opsJson: string;
  startIndex: number;
  endIndex: number;
  scope: string;
  branch: string;
  timestamp: string;
}

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

export class CollabOpsFeed {
  constructor(private readonly client: SwarmClient) {}

  // ─── Topics ────────────────────────────────────────────────────

  static topicFor(
    collabId: CollabId,
    driveId: string,
    documentId?: string,
  ): Topic {
    const raw = documentId
      ? collabDocOpsTopic(collabId, driveId, documentId)
      : collabDriveOpsTopic(collabId, driveId);
    return Topic.fromString(raw);
  }

  // ─── Write side ────────────────────────────────────────────────

  /**
   * Append a batch of ops to this writer's per-collab feed.
   *
   * @param granteeHistRef ACT grantee-chain head that the caller has
   *        already created (via SwarmClient.createGrantees). The caller
   *        (CollabManager) owns this lifecycle so revocation can rotate
   *        the chain without losing track of it.
   */
  async appendBatch(
    collabId: CollabId,
    driveId: string,
    documentId: string | undefined,
    batch: CollabOpsBatch,
    granteeHistRef: string,
  ): Promise<void> {
    // Upload ACT-protected batch payload to /bzz.
    const { reference: actRef, historyAddress } = await this.client.uploadFile(
      JSON.stringify(batch),
      {
        act: true,
        actHistoryAddress: granteeHistRef,
        skipEncryption: true, // ACT handles it
      },
    );
    const actHist = historyAddress ?? granteeHistRef;

    // Wrapper chunk: [actRef (32B) || actHist (32B)]. Uploaded plaintext so
    // the feed reader can read {actRef, actHist} pair without pre-shared state.
    const wrapper = new Uint8Array(WRAPPER_BYTES);
    wrapper.set(hexToBytes32(actRef), 0);
    wrapper.set(hexToBytes32(actHist), 32);
    const { reference: wrapperRef } = await this.client.uploadData(wrapper, {
      skipEncryption: true,
    });

    // Feed write. The feed is owned by the writer's Swarm signer, so only
    // this participant can append here; other participants read it.
    const topic = CollabOpsFeed.topicFor(collabId, driveId, documentId);
    await this.client.writeFeedPayload(topic, wrapperRef);
  }

  // ─── Read side ─────────────────────────────────────────────────

  /**
   * Latest feed index for a peer's feed, or null if the feed doesn't exist yet.
   */
  async getLatestIndex(
    collabId: CollabId,
    driveId: string,
    documentId: string | undefined,
    peerAddress: string,
  ): Promise<number | null> {
    const topic = CollabOpsFeed.topicFor(collabId, driveId, documentId);
    try {
      const reader = (this.client as any).bee.makeFeedReader(topic, peerAddress);
      const result = await reader.downloadReference();
      return parseFeedIndex(result.feedIndex);
    } catch {
      return null;
    }
  }

  /**
   * Read batches from index `fromIndex` (inclusive) up to and including
   * `toIndex`. Stops early at the first unreadable index (feed boundary or
   * chunk not yet propagated). Skips entries that don't decode to our
   * wrapper format.
   *
   * @param publisherBeeNodePubKey Peer's Bee node pubkey, needed for ACT decrypt.
   */
  async readRange(
    collabId: CollabId,
    driveId: string,
    documentId: string | undefined,
    peerAddress: string,
    fromIndex: number,
    toIndex: number,
    publisherBeeNodePubKey: string,
  ): Promise<Array<{ feedIndex: number; batch: CollabOpsBatch }>> {
    if (fromIndex > toIndex) return [];
    const topic = CollabOpsFeed.topicFor(collabId, driveId, documentId);
    const reader = (this.client as any).bee.makeFeedReader(topic, peerAddress);
    const out: Array<{ feedIndex: number; batch: CollabOpsBatch }> = [];

    for (let i = fromIndex; i <= toIndex; i++) {
      let wrapperRef: string;
      try {
        const result = await reader.downloadReference({
          index: FeedIndex.fromBigInt(BigInt(i)),
        });
        wrapperRef = result.reference.toHex();
      } catch {
        // Index unavailable — treat as end of readable range and stop walking.
        break;
      }

      try {
        const wrapperBytes = await this.client.downloadData(wrapperRef, {
          skipDecryption: true,
        });
        if (wrapperBytes.length !== WRAPPER_BYTES) {
          continue; // not our wrapper format
        }
        const actRef = bytes32ToHex(wrapperBytes, 0);
        const actHist = bytes32ToHex(wrapperBytes, 32);
        const data = await this.client.downloadFile(actRef, {
          actPublisher: publisherBeeNodePubKey,
          actHistoryAddress: actHist,
          skipDecryption: true,
        });
        const batch = JSON.parse(new TextDecoder().decode(data)) as CollabOpsBatch;
        out.push({ feedIndex: i, batch });
      } catch {
        // ACT decrypt failed (chunks not propagated yet, grantee not yet
        // visible to this node, etc). Skip this entry; a future poll can
        // pick it up once chunks propagate.
        continue;
      }
    }

    return out;
  }
}
