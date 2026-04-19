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
export class PushHook {
    client;
    opsFeed;
    store;
    gsoc;
    myAddress;
    refreshManifest;
    isShuttingDown;
    /** Per-collabId in-flight grantee-chain creation. Without this,
     *  two parallel handleLocalPush calls (e.g. SwarmChannel flushing
     *  two docs at once) both create a fresh chain; whoever writes
     *  summaries.set last wins, and the first writer's ops are uploaded
     *  under an orphaned chain that peers can't decrypt. */
    granteeChainInFlight = new Map();
    constructor(client, opsFeed, store, gsoc, myAddress, refreshManifest, isShuttingDown) {
        this.client = client;
        this.opsFeed = opsFeed;
        this.store = store;
        this.gsoc = gsoc;
        this.myAddress = myAddress;
        this.refreshManifest = refreshManifest;
        this.isShuttingDown = isShuttingDown;
    }
    async handleLocalPush(input) {
        if (this.isShuttingDown())
            return;
        if (!input.ops?.length)
            return;
        // Skip reactor-machinery ops entirely. scope="document" carries
        // CREATE_DOCUMENT + UPGRADE_DOCUMENT — per-node bootstrap that
        // every participant produces independently when the drive/doc is
        // first materialized (via applyDocumentBundle on joiners, via
        // addDrive on the initiator). Mirroring them would hand a peer an
        // op at index 0 for a document they already have at revision 3+,
        // triggering a RevisionMismatchError in their reactor. We only
        // mirror scope="global" content edits (ADD_FILE, SET_NAME, etc.).
        if (input.scope === "document")
            return;
        // Mirror only ops we actually authored. SwarmChannel's outbox
        // grows whenever the reactor writes ops — including sync'd ops
        // from peers applied via `reactor.load`. Without this filter we
        // echo every received op back to the collab feed, which shows up
        // as a phantom "peer applied 1 op" row on the original sender's
        // UI and wastes bandwidth.
        const authoredOps = input.ops.filter((o) => opAuthor(o) === this.myAddress.toLowerCase());
        if (authoredOps.length === 0)
            return;
        const relevant = this.findCollabsCoveringDoc(input.driveId, input.docId);
        if (relevant.length === 0)
            return;
        const startIndex = authoredOps[0]?.operation.index ?? 0;
        const endIndex = authoredOps[authoredOps.length - 1]?.operation.index ?? 0;
        for (const summary of relevant) {
            await this.mirrorToCollab(summary, { ...input, ops: authoredOps }, startIndex, endIndex);
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
    async mirrorToCollab(summary, input, startIndex, endIndex) {
        try {
            const granteeHistRef = await this.ensureGranteeChainForLocalWrite(summary);
            if (!granteeHistRef)
                return; // not enough info to mirror yet
            const batch = {
                opsJson: JSON.stringify(input.ops),
                startIndex,
                endIndex,
                scope: input.scope,
                branch: input.branch,
                timestamp: new Date().toISOString(),
            };
            const writeResult = await this.opsFeed.appendBatch(summary.collabId, input.driveId, input.docId, batch, granteeHistRef);
            const live = this.store.get(summary.collabId);
            if (live) {
                this.store.set(summary.collabId, {
                    ...live,
                    lastActivityAt: new Date().toISOString(),
                });
            }
            // Fire-and-forget GSOC ping — feed write already succeeded, the
            // ping is a speed optimization for receivers.
            void this.gsoc
                .pingOpCommitted(this.store.get(summary.collabId) ?? summary, input.driveId, input.docId, {
                ...writeResult,
                ops: input.ops,
                scope: input.scope,
                branch: input.branch,
            })
                .catch(() => { });
        }
        catch (err) {
            console.warn(`[CollabManager] mirror push failed for ${summary.collabId} doc ${input.docId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
        }
    }
    /**
     * Return a live ACT grantee-chain head for writes on this collab. For
     * the initiator this is just the summary's `currentGranteeHistRef`.
     * For joiners, this lazily creates a chain the first time we write,
     * using the participant list from the manifest feed.
     *
     * Concurrency-safe per collabId: parallel callers await the same
     * pending chain-creation promise instead of each creating their own.
     */
    async ensureGranteeChainForLocalWrite(summary) {
        if (summary.currentGranteeHistRef)
            return summary.currentGranteeHistRef;
        const pending = this.granteeChainInFlight.get(summary.collabId);
        if (pending)
            return pending;
        const promise = this.buildGranteeChain(summary);
        this.granteeChainInFlight.set(summary.collabId, promise);
        try {
            return await promise;
        }
        finally {
            if (this.granteeChainInFlight.get(summary.collabId) === promise) {
                this.granteeChainInFlight.delete(summary.collabId);
            }
        }
    }
    async buildGranteeChain(summary) {
        // Re-read the summary inside the "lock" in case another caller
        // already wrote a chain while we were queuing.
        const live = this.store.get(summary.collabId) ?? summary;
        if (live.currentGranteeHistRef)
            return live.currentGranteeHistRef;
        let workingSummary = live;
        const knownKeys = live.participants.filter((p) => p.beeNodePublicKey);
        if (knownKeys.length < live.participants.length) {
            const refreshed = await this.refreshManifest(live.collabId).catch(() => null);
            if (refreshed?.currentGranteeHistRef)
                return refreshed.currentGranteeHistRef;
            workingSummary = refreshed ?? this.store.get(live.collabId) ?? live;
        }
        const liveKeys = workingSummary.participants
            .map((p) => p.beeNodePublicKey)
            .filter((k) => !!k);
        if (liveKeys.length < 2)
            return null;
        const { ref, historyRef } = await this.client.createGrantees(liveKeys);
        // ACT's 1-second rule between chain touches — don't race the next
        // write into the same mantaray timestamp bucket.
        await new Promise((r) => setTimeout(r, 1100));
        const latest = this.store.get(workingSummary.collabId) ?? workingSummary;
        this.store.set(workingSummary.collabId, {
            ...latest,
            currentGranteeRef: ref,
            currentGranteeHistRef: historyRef,
        });
        return historyRef;
    }
}
/**
 * Extract the authoring wallet address from an OperationWithContext.
 * The reactor stores the author under `action.context.signer.user.address`;
 * returns a lowercased string for stable comparison. Returns null if
 * the path isn't present (e.g. legacy ops without signer context).
 */
function opAuthor(op) {
    const signer = op.operation?.action?.context?.signer?.user?.address;
    return typeof signer === "string" ? signer.toLowerCase() : null;
}
//# sourceMappingURL=push-hook.js.map