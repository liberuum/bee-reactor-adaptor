/**
 * PushHook — local-push mirroring to collab feeds.
 *
 * Called by SwarmChannel on every successful personal-feed push. For
 * each active collab that covers this (driveId, docId), we:
 *   1. Ensure an ACT grantee chain exists for our writes (initiator
 *      gets one at create-time; joiners lazily build one on first push).
 *   2. Append the same batch to the collab's ACT-protected per-peer
 *      feed under that grantee chain.
 *   3. Fire a best-effort GSOC ping so peers get sub-second delivery.
 *
 * Errors are logged but not thrown — the primary personal-feed push
 * already succeeded; the collab mirror retries on the next push.
 */
import type { SwarmClient } from "../../swarm-client.js";
import type { OperationWithContext } from "../../swarm-operation-store.js";
import type { CollabOpsFeed } from "../collab-ops-feed.js";
import type { CollabId, CollabSummary } from "../types.js";
import type { GsocCoordinator } from "./gsoc-coordinator.js";
import { SummaryStore } from "./store.js";
export interface LocalPushInput {
    driveId: string;
    docId: string;
    /** SwarmChannel hands us OperationWithContext[] — each entry wraps a
     *  bare Operation plus its OperationContext. Peers read these back
     *  from the collab feed and unwrap to `.operation` before applying. */
    ops: readonly OperationWithContext[];
    scope: string;
    branch: string;
}
/**
 * Caller-supplied way to resolve a fresh manifest read. Break the
 * import cycle between push-hook and lifecycle (which owns
 * refreshManifest) by taking the callback explicitly.
 */
export type RefreshManifest = (collabId: CollabId) => Promise<CollabSummary | null>;
export declare class PushHook {
    private readonly client;
    private readonly opsFeed;
    private readonly store;
    private readonly gsoc;
    private readonly myAddress;
    private readonly refreshManifest;
    private readonly isShuttingDown;
    /** Per-collabId in-flight grantee-chain creation. Without this,
     *  two parallel handleLocalPush calls (e.g. SwarmChannel flushing
     *  two docs at once) both create a fresh chain; whoever writes
     *  summaries.set last wins, and the first writer's ops are uploaded
     *  under an orphaned chain that peers can't decrypt. */
    private readonly granteeChainInFlight;
    constructor(client: SwarmClient, opsFeed: CollabOpsFeed, store: SummaryStore, gsoc: GsocCoordinator, myAddress: string, refreshManifest: RefreshManifest, isShuttingDown: () => boolean);
    handleLocalPush(input: LocalPushInput): Promise<void>;
    /**
     * Find collabs that should mirror a given (driveId, docId):
     *   - Drive-level collabs: every doc in that drive counts.
     *   - Doc-level collabs: only the specific doc.
     */
    private findCollabsCoveringDoc;
    private mirrorToCollab;
    /**
     * Return a live ACT grantee-chain head for writes on this collab. For
     * the initiator this is just the summary's `currentGranteeHistRef`.
     * For joiners, this lazily creates a chain the first time we write,
     * using the participant list from the manifest feed.
     *
     * Concurrency-safe per collabId: parallel callers await the same
     * pending chain-creation promise instead of each creating their own.
     */
    private ensureGranteeChainForLocalWrite;
    private buildGranteeChain;
}
//# sourceMappingURL=push-hook.d.ts.map