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
import { Topic } from "@ethersphere/bee-js";
import type { SwarmClient } from "../swarm-client.js";
import type { CollabId } from "./types.js";
export interface CollabOpsBatch {
    /** Raw op array serialized to JSON. */
    opsJson: string;
    startIndex: number;
    endIndex: number;
    scope: string;
    branch: string;
    timestamp: string;
}
export declare class CollabOpsFeed {
    private readonly client;
    /** granteeRef cache keyed by `${collabId}:${driveId}[:${docId}]`. */
    private granteeCache;
    constructor(client: SwarmClient);
    static topicFor(collabId: CollabId, driveId: string, documentId?: string): Topic;
    /**
     * Ensure a grantee list exists for this collab feed. Cached per
     * (collabId, driveId, docId?) because the same grantee chain covers every
     * write to the same feed (participants only change when the manifest is
     * rewritten, which is a future milestone).
     */
    private ensureGrantees;
    /**
     * Append a batch of ops to this writer's per-collab feed.
     *
     * @param granteeBeePubKeys - every participant's Bee node pubkey (including self).
     */
    appendBatch(collabId: CollabId, driveId: string, documentId: string | undefined, batch: CollabOpsBatch, granteeBeePubKeys: string[]): Promise<void>;
    /**
     * Latest feed index for a peer's feed, or null if the feed doesn't exist yet.
     */
    getLatestIndex(collabId: CollabId, driveId: string, documentId: string | undefined, peerAddress: string): Promise<number | null>;
    /**
     * Read batches from index `fromIndex` (inclusive) up to and including
     * `toIndex`. Stops early at the first unreadable index (feed boundary or
     * chunk not yet propagated). Skips entries that don't decode to our
     * wrapper format.
     *
     * @param publisherBeeNodePubKey Peer's Bee node pubkey, needed for ACT decrypt.
     */
    readRange(collabId: CollabId, driveId: string, documentId: string | undefined, peerAddress: string, fromIndex: number, toIndex: number, publisherBeeNodePubKey: string): Promise<Array<{
        feedIndex: number;
        batch: CollabOpsBatch;
    }>>;
}
//# sourceMappingURL=collab-ops-feed.d.ts.map