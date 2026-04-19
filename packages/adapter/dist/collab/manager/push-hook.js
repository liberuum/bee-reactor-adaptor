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
export class PushHook {
    store;
    flusher;
    appliedOpsTracker;
    isShuttingDown;
    constructor(store, flusher, appliedOpsTracker, isShuttingDown) {
        this.store = store;
        this.flusher = flusher;
        this.appliedOpsTracker = appliedOpsTracker;
        this.isShuttingDown = isShuttingDown;
    }
    async handleLocalPush(input) {
        if (this.isShuttingDown())
            return;
        if (!input.ops?.length)
            return;
        // (1) Skip reactor-machinery ops entirely.
        if (input.scope === "document")
            return;
        // (2) Drop ops we applied from peer-sync paths — those would echo
        // back to the author as phantom "peer applied 1 op" rows and
        // waste bandwidth re-encrypting the same batch.
        const localOps = input.ops.filter((o) => {
            const id = o.operation?.id;
            if (typeof id !== "string")
                return true; // legacy payload, keep it
            return !this.appliedOpsTracker.wasAppliedViaSync(id);
        });
        if (localOps.length === 0)
            return;
        const relevant = this.findCollabsCoveringDoc(input.driveId, input.docId);
        if (relevant.length === 0)
            return;
        for (const summary of relevant) {
            this.flusher.queue(summary, {
                driveId: input.driveId,
                docId: input.docId,
                ops: localOps,
                scope: input.scope,
                branch: input.branch,
            });
        }
    }
    /**
     * Find collabs that should mirror a given (driveId, docId):
     *   - Drive-level collabs: every doc in that drive counts.
     *   - Doc-level collabs: only the specific doc.
     */
    findCollabsCoveringDoc(driveId, docId) {
        const out = [];
        for (const s of this.store.values()) {
            if (s.driveId !== driveId)
                continue;
            if (s.kind === "document" && s.documentId !== docId)
                continue;
            out.push(s);
        }
        return out;
    }
}
//# sourceMappingURL=push-hook.js.map