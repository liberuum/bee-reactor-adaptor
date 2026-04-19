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
/** Debounce window. Balanced:
 *  - long enough to coalesce typing bursts into one ACT write
 *    (mantaray 1-sec bucket rule → floor is 1100ms anyway).
 *  - short enough that a single op feels responsive end-to-end
 *    (~1.5s debounce + ~0.5s ACT upload + ~0.5s ping delivery =
 *    under 3s, matching chat's perceived latency). */
const DEBOUNCE_MS = 1500;
/** ACT mantaray timestamps bucket by full second. Back-off between
 *  grantee-chain touches (createGrantees / grantAccess) to avoid
 *  collision on the initial chain + the first batch write. */
const GRANTEE_CHAIN_COOLDOWN_MS = 1100;
export class CollabFeedFlusher {
    client;
    opsFeed;
    store;
    gsoc;
    refreshManifest;
    pending = new Map();
    timers = new Map();
    /** Per-collabId in-flight grantee-chain creation. Parallel
     *  `queue()` calls for docs sharing a chain all await the same
     *  chain-build promise instead of each racing their own; otherwise
     *  the first writer's ops get uploaded under an orphaned chain
     *  that peers can't decrypt. */
    granteeChainInFlight = new Map();
    constructor(client, opsFeed, store, gsoc, refreshManifest) {
        this.client = client;
        this.opsFeed = opsFeed;
        this.store = store;
        this.gsoc = gsoc;
        this.refreshManifest = refreshManifest;
    }
    /**
     * Accumulate ops for later feed write + ping. If a batch is already
     * queued for this (collab, drive, doc), merge the new ops in and
     * reset the debounce timer — a continuing typing burst should keep
     * extending the window, not fire mid-burst.
     */
    queue(summary, input) {
        if (input.ops.length === 0)
            return;
        const key = batchKey(summary.collabId, input.driveId, input.docId);
        const existing = this.pending.get(key);
        const merged = existing
            ? { ...existing, ops: [...existing.ops, ...input.ops] }
            : {
                summary,
                driveId: input.driveId,
                docId: input.docId,
                scope: input.scope,
                branch: input.branch,
                ops: [...input.ops],
                firstQueuedAt: Date.now(),
            };
        this.pending.set(key, merged);
        const existingTimer = this.timers.get(key);
        if (existingTimer)
            clearTimeout(existingTimer);
        const timer = setTimeout(() => { void this.flushOne(key); }, DEBOUNCE_MS);
        this.timers.set(key, timer);
    }
    /**
     * Drain every pending batch immediately. Called on shutdown so no
     * op is lost when the user closes the tab mid-type. Errors per-batch
     * are logged inside `flushOne` and never bubble.
     */
    async flushAll() {
        const keys = Array.from(this.pending.keys());
        for (const key of keys) {
            const timer = this.timers.get(key);
            if (timer)
                clearTimeout(timer);
            this.timers.delete(key);
        }
        await Promise.all(keys.map((key) => this.flushOne(key)));
    }
    /**
     * Flush a single queued batch. Never throws — mirror failures are
     * logged and left for the next debounced flush to retry implicitly
     * (new ops added after a failure will queue up, and the next timer
     * tick will attempt the full merged batch).
     */
    async flushOne(key) {
        const entry = this.pending.get(key);
        if (!entry)
            return;
        this.pending.delete(key);
        this.timers.delete(key);
        if (entry.ops.length === 0)
            return;
        try {
            const granteeHistRef = await this.ensureGranteeChainForLocalWrite(entry.summary);
            if (!granteeHistRef) {
                // Not enough info to mirror yet (joiner whose manifest feed
                // hasn't propagated). Put the ops back at the front of the
                // queue so they don't get lost, and the next push will
                // trigger another flush.
                const current = this.pending.get(key);
                this.pending.set(key, current ? { ...current, ops: [...entry.ops, ...current.ops] } : entry);
                return;
            }
            const batch = {
                opsJson: JSON.stringify(entry.ops),
                startIndex: entry.ops[0].operation.index,
                endIndex: entry.ops[entry.ops.length - 1].operation.index,
                scope: entry.scope,
                branch: entry.branch,
                timestamp: new Date().toISOString(),
            };
            const writeResult = await this.opsFeed.appendBatch(entry.summary.collabId, entry.driveId, entry.docId, batch, granteeHistRef);
            const live = this.store.get(entry.summary.collabId);
            if (live) {
                this.store.set(entry.summary.collabId, {
                    ...live,
                    lastActivityAt: new Date().toISOString(),
                });
            }
            // Ping peers with inline ops + refs. Feed is already written so
            // the refs are valid — no longer racing with mantaray timestamps.
            // Receivers use the inline fast path when ops fit, fall back to
            // /bzz refs when they don't, and the poll loop eventually reads
            // the feed for anyone who misses both.
            void this.gsoc
                .pingOpCommitted(this.store.get(entry.summary.collabId) ?? entry.summary, entry.driveId, entry.docId, {
                ...writeResult,
                ops: entry.ops,
                scope: entry.scope,
                branch: entry.branch,
            })
                .catch(() => { });
        }
        catch (err) {
            console.warn(`[CollabManager] mirror flush failed for ${entry.summary.collabId} doc ${entry.docId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
        }
    }
    // ─── Grantee chain (moved from PushHook) ───────────────────────
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
    async ensureGranteeChainForLocalWrite(summary) {
        const live = this.store.get(summary.collabId) ?? summary;
        if (live.currentGranteeHistRef)
            return live.currentGranteeHistRef;
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
        await new Promise((r) => setTimeout(r, GRANTEE_CHAIN_COOLDOWN_MS));
        const latest = this.store.get(workingSummary.collabId) ?? workingSummary;
        this.store.set(workingSummary.collabId, {
            ...latest,
            currentGranteeRef: ref,
            currentGranteeHistRef: historyRef,
        });
        return historyRef;
    }
}
function batchKey(collabId, driveId, docId) {
    return `${collabId}:${driveId}:${docId}`;
}
//# sourceMappingURL=feed-flusher.js.map