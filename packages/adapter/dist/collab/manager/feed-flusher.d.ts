/**
 * CollabFeedFlusher — debounced writer for the ACT-protected collab
 * ops feed.
 *
 * The collab feed is a durability log, not a transport. Before this
 * module, every `handleLocalPush` triggered an immediate
 * `uploadFile(act:true)` on the shared grantee chain — and rapid
 * edits collided inside mantaray's 1-second timestamp bucket, so the
 * second write silently overwrote the first and its `actRef` became
 * a 404. Chat solved the analogous problem by debouncing history
 * writes (see `ChatManager.queueMessageForHistory`); we do the same.
 *
 * Flow:
 *   handleLocalPush → queue(summary, {ops, ...})
 *                      ├─ accumulate in `pending` keyed by (collab, drive, doc)
 *                      └─ (re)schedule 1.5s debounce timer
 *
 *   1.5s of quiescence → flushOne(key):
 *     ├─ resolve grantee chain (initiator-from-create, joiner-from-manifest)
 *     ├─ opsFeed.appendBatch  ← one ACT write per burst, no race
 *     ├─ update summary.lastActivityAt
 *     └─ fire GSOC ping with inline ops + refs so peers apply zero-RTT
 *
 * Shutdown path:
 *   flushAll() cancels pending timers and drains every queued batch,
 *   so no op is lost if the user closes the tab mid-type.
 */
import type { SwarmClient } from "../../swarm-client.js";
import type { OperationWithContext } from "../../swarm-operation-store.js";
import type { CollabOpsFeed } from "../collab-ops-feed.js";
import type { CollabId, CollabSummary } from "../types.js";
import type { GsocCoordinator } from "./gsoc-coordinator.js";
import type { SummaryStore } from "./store.js";
/**
 * Called by the flusher when it needs the latest manifest (e.g. to
 * learn a joiner's own pubkey so the grantee chain can include them).
 * Broken out as a callback to avoid a cyclic import with `lifecycle.ts`.
 */
export type RefreshManifest = (collabId: CollabId) => Promise<CollabSummary | null>;
export interface QueueInput {
    driveId: string;
    docId: string;
    ops: readonly OperationWithContext[];
    scope: string;
    branch: string;
}
export declare class CollabFeedFlusher {
    private readonly client;
    private readonly opsFeed;
    private readonly store;
    private readonly gsoc;
    private readonly refreshManifest;
    private readonly pending;
    private readonly timers;
    /** Per-collabId in-flight grantee-chain creation. Parallel
     *  `queue()` calls for docs sharing a chain all await the same
     *  chain-build promise instead of each racing their own; otherwise
     *  the first writer's ops get uploaded under an orphaned chain
     *  that peers can't decrypt. */
    private readonly granteeChainInFlight;
    constructor(client: SwarmClient, opsFeed: CollabOpsFeed, store: SummaryStore, gsoc: GsocCoordinator, refreshManifest: RefreshManifest);
    /**
     * Accumulate ops for later feed write + ping. If a batch is already
     * queued for this (collab, drive, doc), merge the new ops in and
     * reset the debounce timer — a continuing typing burst should keep
     * extending the window, not fire mid-burst.
     */
    queue(summary: CollabSummary, input: QueueInput): void;
    /**
     * Drain every pending batch immediately. Called on shutdown so no
     * op is lost when the user closes the tab mid-type. Errors per-batch
     * are logged inside `flushOne` and never bubble.
     */
    flushAll(): Promise<void>;
    /**
     * Flush a single queued batch. Never throws — mirror failures are
     * logged and left for the next debounced flush to retry implicitly
     * (new ops added after a failure will queue up, and the next timer
     * tick will attempt the full merged batch).
     */
    private flushOne;
    /**
     * Return a live ACT grantee-chain head for writes on this collab.
     * For the initiator this is just the summary's
     * `currentGranteeHistRef`. For joiners, this lazily creates a chain
     * the first time we write, using the participant list from the
     * manifest feed.
     *
     * Concurrency-safe per collabId: parallel callers await the same
     * pending chain-creation promise instead of each creating their
     * own.
     */
    private ensureGranteeChainForLocalWrite;
    private buildGranteeChain;
}
//# sourceMappingURL=feed-flusher.d.ts.map