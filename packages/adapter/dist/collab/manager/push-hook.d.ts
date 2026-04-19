/**
 * PushHook — entry point for SwarmChannel's "we just pushed ops
 * locally" callback. Filters the batch and hands off to the
 * {@link CollabFeedFlusher}, which owns the debounced ACT feed write
 * + GSOC ping.
 *
 * Two filtering concerns live here:
 *
 *   1. Drop reactor-machinery ops. `scope="document"` carries
 *      CREATE_DOCUMENT / UPGRADE_DOCUMENT which every participant
 *      produces independently when the drive/doc is first
 *      materialized. Mirroring them hands peers an op at index 0 for
 *      a document they already have at revision 3+, triggering a
 *      RevisionMismatchError in their reactor.
 *
 *   2. Don't echo peer-authored ops. SwarmChannel's outbox grows on
 *      every reactor write — including ops loaded via sync. The
 *      {@link AppliedOpsTracker} remembers IDs we applied from peer
 *      pings/polls, so we can tell "locally authored" apart from
 *      "we just finished ingesting this from a peer".
 */
import type { OperationWithContext } from "../../swarm-operation-store.js";
import type { AppliedOpsTracker } from "./applied-ops-tracker.js";
import type { CollabFeedFlusher } from "./feed-flusher.js";
import type { SummaryStore } from "./store.js";
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
export declare class PushHook {
    private readonly store;
    private readonly flusher;
    private readonly appliedOpsTracker;
    private readonly isShuttingDown;
    constructor(store: SummaryStore, flusher: CollabFeedFlusher, appliedOpsTracker: AppliedOpsTracker, isShuttingDown: () => boolean);
    handleLocalPush(input: LocalPushInput): Promise<void>;
    /**
     * Find collabs that should mirror a given (driveId, docId):
     *   - Drive-level collabs: every doc in that drive counts.
     *   - Doc-level collabs: only the specific doc.
     */
    private findCollabsCoveringDoc;
}
//# sourceMappingURL=push-hook.d.ts.map