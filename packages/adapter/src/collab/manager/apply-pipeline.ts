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

import type { CollabOpsFeed } from "../collab-ops-feed.js";
import type { CollabId, CollabSummary } from "../types.js";
import type { CollabEventBus } from "./event-bus.js";
import { dispatchWindowEvent, getReactor } from "./reactor-bridge.js";
import { pushActivity, SummaryStore } from "./store.js";

/**
 * Recognize the reactor's `RevisionMismatchError` by name — we don't
 * import the class because it lives in the reactor package and
 * structural matching is enough.
 */
function isRevisionMismatchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "RevisionMismatchError") return true;
  return /Revision mismatch: expected /.test(err.message);
}

export interface InlineOpsInput {
  ops: unknown[];
  docId: string;
  scope: string;
  branch: string;
  feedIndex?: number;
}

export interface RefsFetchInput {
  actRef: string;
  actHistoryAddress: string;
  feedIndex: number;
  publisherBeeNodePubKey: string;
  driveId: string;
  docId: string;
}

export interface ApplyInput {
  collabId: CollabId;
  writer: string;
  docId: string;
  branch: string;
  ops: unknown;
  feedIndex?: number;
}

/**
 * When the /bzz refs-fetch retry exhausts, caller wants a poll-loop
 * kick. We avoid a direct dep on PollLoop to keep the DAG acyclic.
 */
export type PollKick = () => void;

export class ApplyPipeline {
  constructor(
    private readonly store: SummaryStore,
    private readonly events: CollabEventBus,
    private readonly opsFeed: CollabOpsFeed,
    /** Signals the caller to schedule a poll-loop tick as a fallback. */
    private readonly pollKick: PollKick,
    /** Set to `true` by the owning manager during shutdown so retry
     *  loops bail promptly. */
    private readonly isShuttingDown: () => boolean,
  ) {}

  /**
   * Zero-RTT apply. On failure, falls back to a poll-loop kick — the
   * caller needn't re-throw.
   */
  async applyInlineOps(
    summary: CollabSummary,
    writer: string,
    input: InlineOpsInput,
  ): Promise<void> {
    try {
      await this.applyAndAdvance({
        collabId: summary.collabId,
        writer,
        docId: input.docId,
        branch: input.branch,
        ops: input.ops,
        feedIndex: input.feedIndex,
      });
    } catch (err) {
      console.warn(
        `[CollabManager] inline-ops apply failed for ${summary.collabId}, falling back to feed pull:`,
        err instanceof Error ? err.message : err,
      );
      this.pollKick();
    }
  }

  /**
   * Fast-path apply from a GSOC ping's refs. Retries with exponential
   * backoff up to ~15s because the chunk may not have propagated yet
   * even though the ping did. Falls back to a poll-loop kick if every
   * attempt fails.
   */
  async applyFromPing(
    summary: CollabSummary,
    writer: string,
    refs: RefsFetchInput,
  ): Promise<void> {
    const waits = [0, 500, 1000, 2000, 4000, 8000];
    for (const wait of waits) {
      if (this.isShuttingDown()) return;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const batch = await this.opsFeed.fetchByRefs(
        refs.actRef,
        refs.actHistoryAddress,
        refs.publisherBeeNodePubKey,
      );
      if (!batch) continue;
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
        if (applied) return;
      } catch (err) {
        console.warn(
          `[CollabManager] fast-path apply failed for ${summary.collabId} (will retry):`,
          err instanceof Error ? err.message : err,
        );
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
  async applyAndAdvance(input: ApplyInput): Promise<boolean> {
    const reactor = getReactor();
    if (typeof reactor?.load !== "function") return false;

    if (!Array.isArray(input.ops) || input.ops.length === 0) return true;

    // Idempotency guard: skip entirely if we've already processed a
    // batch at this feedIndex or later. Without this, the GSOC inline
    // ping and the 5s poll both fire `applyAndAdvance` for the same
    // batch, and even though `reactor.load` is a no-op on repeat (op
    // IDs dedupe), the side effects — `peerActivity.opsApplied++` and
    // `recentActivity` append — stack up per call, producing duplicate
    // "applied N ops" rows in the UI.
    if (input.feedIndex !== undefined) {
      const cursor = this.store.readCursor(
        input.collabId,
        input.writer,
        input.docId,
      );
      if (input.feedIndex + 1 <= cursor) return true;
    }

    // SwarmChannel pushes OperationWithContext[]; reactor.load needs
    // bare Operation[]. Unwrap defensively — fall back to the entry
    // itself for already-flat payloads.
    const ops = (input.ops as readonly unknown[]).map((entry) => {
      if (entry && typeof entry === "object" && "operation" in entry) {
        return (entry as { operation: unknown }).operation;
      }
      return entry;
    });

    try {
      await reactor.load(input.docId, input.branch, ops);
    } catch (err) {
      // RevisionMismatchError = "I already have this op at this
      // revision". Normal when a peer replays bootstrap ops (they
      // produced their own independently via applyDocumentBundle).
      // Treat as idempotent: still advance the cursor, still emit
      // activity, don't bubble up as an error.
      if (isRevisionMismatchError(err)) {
        console.debug(
          `[CollabManager] apply skipped (revision mismatch): ${input.collabId} doc ${input.docId.slice(0, 8)} — peer already has these ops`,
        );
      } else {
        throw err;
      }
    }

    if (input.feedIndex !== undefined) {
      this.store.writeCursor(
        input.collabId,
        input.writer,
        input.docId,
        input.feedIndex + 1,
      );
    }

    this.bumpPeerActivity(input.collabId, input.writer, ops.length, input.docId);
    this.events.emit({ type: "op-applied", collabId: input.collabId });
    dispatchWindowEvent("swarm:collab:op-applied", { collabId: input.collabId });
    return true;
  }

  private bumpPeerActivity(
    collabId: CollabId,
    writer: string,
    opsCount: number,
    docId: string,
  ): void {
    const liveSummary = this.store.get(collabId);
    if (!liveSummary) return;

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
