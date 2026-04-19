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
    /** Last index we wrote per topic. Same staleness workaround as the
     *  manifest feed — bee-js's auto-pick pre-read can be stale on public
     *  nodes, so we track indices ourselves and write at an explicit index. */
    private lastWrittenIndex;
    /** Per-collab in-flight append — serializes concurrent appendBatch
     *  calls that share an ACT grantee chain (every doc under the same
     *  collab does). Without this, parallel writes on the same chain
     *  collide on mantaray's 1-second timestamp bucket and one of them
     *  becomes unreadable. Keyed by collabId because that's the
     *  stable-per-chain identifier — granteeHistRef changes on every
     *  write. */
    private appendInFlight;
    constructor(client: SwarmClient);
    /**
     * Resolve the Swarm feed topic for a per-peer collab ops feed.
     *
     * Note: production callers always pass `documentId`. Drive-level
     * ops are stored under the doc-scoped topic with `docId === driveId`
     * (see `handleLocalPush` + `pollSummary`'s `docIds.unshift(driveId)`).
     * The `documentId`-omitted branch is retained for future flexibility
     * and is exercised by the unit test.
     */
    static topicFor(collabId: CollabId, driveId: string, documentId?: string): Topic;
    /**
     * Append a batch of ops to this writer's per-collab feed.
     *
     * @param granteeHistRef ACT grantee-chain head that the caller has
     *        already created (via SwarmClient.createGrantees). The caller
     *        (CollabManager) owns this lifecycle so revocation can rotate
     *        the chain without losing track of it.
     */
    appendBatch(collabId: CollabId, driveId: string, documentId: string | undefined, batch: CollabOpsBatch, granteeHistRef: string): Promise<{
        actRef: string;
        actHistoryAddress: string;
        feedIndex: number;
    }>;
    private appendBatchLocked;
    /**
     * Fast-path download: given the actRef + actHistoryAddress carried
     * in a GSOC `op-committed` ping, fetch the batch payload directly
     * from /bzz — bypassing the feed read entirely. This is the main
     * latency win, because cross-node feed propagation is slower than
     * cross-node /bzz content-addressed retrieval.
     *
     * Returns null on any download/decrypt failure (chunks not yet
     * propagated to the reader's neighborhood); caller should fall back
     * to the feed path.
     */
    fetchByRefs(actRef: string, actHistoryAddress: string, publisherBeeNodePubKey: string): Promise<CollabOpsBatch | null>;
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