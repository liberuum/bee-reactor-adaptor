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
import { Topic } from "@ethersphere/bee-js";
import type { SwarmClient } from "../swarm-client.js";
import type { CollabId, CollabManifest } from "./types.js";
export declare class CollabManifestFeed {
    private readonly client;
    /** Last index we wrote per topic. Lets publish() return a correct
     *  feedIndex even when Bee's post-write feed reads are still showing
     *  stale state (which we hit against public nodes). */
    private lastWrittenIndex;
    /** Per-topic in-flight publish — same rationale as CollabOpsFeed's
     *  appendInFlight lock. Prevents two concurrent publish() calls from
     *  both deriving the same nextIndex and colliding on the same SOC. */
    private publishInFlight;
    constructor(client: SwarmClient);
    static topicFor(collabId: CollabId): Topic;
    /**
     * Publish a manifest revision. Caller supplies the grantee set; this
     * class just writes. Rotation (shrinking the grantee list for
     * revocation) is the caller's responsibility: pass a fresh
     * granteeHistRef when the participants change.
     */
    publish(manifest: CollabManifest, granteeHistRef: string): Promise<{
        feedIndex: number;
        actRef: string;
        actHistoryAddress: string;
    }>;
    private publishLocked;
    /**
     * Read the latest manifest revision, or null if the feed doesn't exist
     * or the chunk hasn't propagated to this node yet.
     *
     * @param readerBeeNodePubKey — the initiator's Bee node pubkey. Needed
     *    as `actPublisher` for ACT decrypt.
     */
    readLatest(collabId: CollabId, ownerSignerAddress: string, readerBeeNodePubKey: string): Promise<{
        manifest: CollabManifest;
        feedIndex: number;
    } | null>;
    /**
     * Read a specific feed index, if accessible. Used by participants who
     * were revoked after index N — they can still read up to N via
     * feedIndex lookups.
     */
    readAtIndex(collabId: CollabId, ownerSignerAddress: string, readerBeeNodePubKey: string, index: number): Promise<CollabManifest | null>;
}
//# sourceMappingURL=collab-manifest-feed.d.ts.map