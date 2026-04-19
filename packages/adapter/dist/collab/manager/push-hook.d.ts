/**
 * PushHook — entry point for SwarmChannel's "we just pushed ops
 * locally" callback. Filters the batch and hands off to the
 * {@link CollabFeedFlusher}, which owns the debounced ACT feed write
 * + GSOC ping.
 *
 * Why a separate module:
 *   - This file is the one SwarmChannel talks to via
 *     `__swarmCollabManager__.handleLocalPush`. Keeping it tiny
 *     isolates the IPC surface from the transport details.
 *   - Filtering (scope=document drops, self-author filter) is about
 *     *what* to mirror; flushing is about *when*. Two clean
 *     responsibilities, two small modules.
 */
import type { OperationWithContext } from "../../swarm-operation-store.js";
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
    private readonly myAddress;
    private readonly isShuttingDown;
    constructor(store: SummaryStore, flusher: CollabFeedFlusher, myAddress: string, isShuttingDown: () => boolean);
    handleLocalPush(input: LocalPushInput): Promise<void>;
    /**
     * Find collabs that should mirror a given (driveId, docId):
     *   - Drive-level collabs: every doc in that drive counts.
     *   - Doc-level collabs: only the specific doc.
     */
    private findCollabsCoveringDoc;
}
//# sourceMappingURL=push-hook.d.ts.map