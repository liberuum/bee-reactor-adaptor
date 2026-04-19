/**
 * ApplyPipeline — the three fast-path handlers that land incoming
 * collab ops on the local reactor:
 *
 *   1. `applyInlineOps` — ops arrived inline in a GSOC ping, zero Swarm
 *      round-trips needed (sub-second path).
 *   2. `applyFromPing`  — ping carried only `{actRef, actHistoryAddress,
 *      feedIndex}`, we fetch the chunk via /bzz (skips feed read).
 *   3. `applyAndAdvance` — the shared tail: unwrap
 *      OperationWithContext → `reactor.load` → advance cursor → emit
 *      `op-applied` → bump peerActivity.
 *
 * Fallback to the poll loop is owned by the caller — the pipeline just
 * surfaces `false`/throws so the caller can decide whether to retry or
 * queue a `pollOnce()`.
 */
import { dispatchWindowEvent, getReactor } from "./reactor-bridge.js";
import { pushActivity } from "./store.js";
/**
 * Recognize the reactor's `RevisionMismatchError` by name — we don't
 * import the class because it lives in the reactor package and
 * structural matching is enough.
 */
function isRevisionMismatchError(err) {
    if (!(err instanceof Error))
        return false;
    if (err.name === "RevisionMismatchError")
        return true;
    return /Revision mismatch: expected /.test(err.message);
}
export class ApplyPipeline {
    store;
    events;
    opsFeed;
    pollKick;
    isShuttingDown;
    appliedOpsTracker;
    constructor(store, events, opsFeed, 
    /** Signals the caller to schedule a poll-loop tick as a fallback. */
    pollKick, 
    /** Set to `true` by the owning manager during shutdown so retry
     *  loops bail promptly. */
    isShuttingDown, 
    /** Remembers op IDs we apply from peer-sync paths so PushHook
     *  doesn't mirror them back to the collab feed as echoes. */
    appliedOpsTracker) {
        this.store = store;
        this.events = events;
        this.opsFeed = opsFeed;
        this.pollKick = pollKick;
        this.isShuttingDown = isShuttingDown;
        this.appliedOpsTracker = appliedOpsTracker;
    }
    /**
     * Zero-RTT apply. On failure, falls back to a poll-loop kick — the
     * caller needn't re-throw.
     */
    async applyInlineOps(summary, writer, input) {
        try {
            await this.applyAndAdvance({
                collabId: summary.collabId,
                writer,
                docId: input.docId,
                branch: input.branch,
                ops: input.ops,
                feedIndex: input.feedIndex,
            });
        }
        catch (err) {
            console.warn(`[CollabManager] inline-ops apply failed for ${summary.collabId}, falling back to feed pull:`, err instanceof Error ? err.message : err);
            this.pollKick();
        }
    }
    /**
     * Fast-path apply from a GSOC ping's refs. Retries with exponential
     * backoff up to ~15s because the chunk may not have propagated yet
     * even though the ping did. Falls back to a poll-loop kick if every
     * attempt fails.
     */
    async applyFromPing(summary, writer, refs) {
        const waits = [0, 500, 1000, 2000, 4000, 8000];
        for (const wait of waits) {
            if (this.isShuttingDown())
                return;
            if (wait > 0)
                await new Promise((r) => setTimeout(r, wait));
            const batch = await this.opsFeed.fetchByRefs(refs.actRef, refs.actHistoryAddress, refs.publisherBeeNodePubKey);
            if (!batch)
                continue;
            try {
                const raw = JSON.parse(batch.opsJson);
                const applied = await this.applyAndAdvance({
                    collabId: summary.collabId,
                    writer,
                    docId: refs.docId,
                    branch: batch.branch ?? "main",
                    ops: raw,
                    feedIndex: refs.feedIndex,
                });
                if (applied)
                    return;
            }
            catch (err) {
                console.warn(`[CollabManager] fast-path apply failed for ${summary.collabId} (will retry):`, err instanceof Error ? err.message : err);
                continue;
            }
        }
        this.pollKick();
    }
    /**
     * Shared tail of every apply path.
     *
     * Returns:
     *   - `true`  — ops applied (zero-length batches count as handled).
     *   - `false` — reactor not yet wired; caller should retry later.
     * Throws on `reactor.load` failures; callers decide whether to retry.
     */
    async applyAndAdvance(input) {
        const reactor = getReactor();
        if (typeof reactor?.load !== "function")
            return false;
        if (!Array.isArray(input.ops) || input.ops.length === 0)
            return true;
        // Idempotency guard: skip entirely if we've already processed a
        // batch at this feedIndex or later. Without this, the GSOC inline
        // ping and the 5s poll both fire `applyAndAdvance` for the same
        // batch, and even though `reactor.load` is a no-op on repeat (op
        // IDs dedupe), the side effects — `peerActivity.opsApplied++` and
        // `recentActivity` append — stack up per call, producing duplicate
        // "applied N ops" rows in the UI.
        if (input.feedIndex !== undefined) {
            const cursor = this.store.readCursor(input.collabId, input.writer, input.docId);
            if (input.feedIndex + 1 <= cursor)
                return true;
        }
        // SwarmChannel pushes OperationWithContext[]; reactor.load needs
        // bare Operation[]. Unwrap defensively — fall back to the entry
        // itself for already-flat payloads.
        const ops = input.ops.map((entry) => {
            if (entry && typeof entry === "object" && "operation" in entry) {
                return entry.operation;
            }
            return entry;
        });
        // Record that each of these ops arrived from a peer (not local
        // execution) BEFORE reactor.load fires. SwarmChannel may see the
        // reactor's write immediately and call handleLocalPush before
        // this function even returns — we need the IDs in the tracker by
        // then so PushHook filters them out. See AppliedOpsTracker for
        // the full echo-loop story.
        for (const op of ops) {
            const id = op?.id;
            if (typeof id === "string")
                this.appliedOpsTracker.markAppliedViaSync(id);
        }
        try {
            await reactor.load(input.docId, input.branch, ops);
        }
        catch (err) {
            // RevisionMismatchError = "I already have this op at this
            // revision". Normal when a peer replays bootstrap ops (they
            // produced their own independently via applyDocumentBundle).
            // Treat as idempotent: still advance the cursor, still emit
            // activity, don't bubble up as an error.
            if (isRevisionMismatchError(err)) {
                console.debug(`[CollabManager] apply skipped (revision mismatch): ${input.collabId} doc ${input.docId.slice(0, 8)} — peer already has these ops`);
            }
            else {
                throw err;
            }
        }
        if (input.feedIndex !== undefined) {
            this.store.writeCursor(input.collabId, input.writer, input.docId, input.feedIndex + 1);
        }
        this.bumpPeerActivity(input.collabId, input.writer, ops.length, input.docId);
        this.events.emit({ type: "op-applied", collabId: input.collabId });
        dispatchWindowEvent("swarm:collab:op-applied", { collabId: input.collabId });
        return true;
    }
    bumpPeerActivity(collabId, writer, opsCount, docId) {
        const liveSummary = this.store.get(collabId);
        if (!liveSummary)
            return;
        const now = new Date().toISOString();
        const writerKey = writer.toLowerCase();
        const priorActivity = liveSummary.peerActivity?.[writerKey];
        const nextPeerActivity = {
            ...(liveSummary.peerActivity ?? {}),
            [writerKey]: {
                lastAppliedAt: now,
                opsApplied: (priorActivity?.opsApplied ?? 0) + opsCount,
            },
        };
        this.store.set(collabId, {
            ...liveSummary,
            lastActivityAt: now,
            peerActivity: nextPeerActivity,
            recentActivity: pushActivity(liveSummary.recentActivity, {
                at: now,
                kind: "ops-applied",
                actor: writerKey,
                opsCount,
                docId,
            }),
        });
    }
}
//# sourceMappingURL=apply-pipeline.js.map