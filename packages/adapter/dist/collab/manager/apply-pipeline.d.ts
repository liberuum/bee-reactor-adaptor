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
import type { AppliedOpsTracker } from "./applied-ops-tracker.js";
import type { CollabEventBus } from "./event-bus.js";
import { SummaryStore } from "./store.js";
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
export declare class ApplyPipeline {
    private readonly store;
    private readonly events;
    private readonly opsFeed;
    /** Signals the caller to schedule a poll-loop tick as a fallback. */
    private readonly pollKick;
    /** Set to `true` by the owning manager during shutdown so retry
     *  loops bail promptly. */
    private readonly isShuttingDown;
    /** Remembers op IDs we apply from peer-sync paths so PushHook
     *  doesn't mirror them back to the collab feed as echoes. */
    private readonly appliedOpsTracker;
    constructor(store: SummaryStore, events: CollabEventBus, opsFeed: CollabOpsFeed, 
    /** Signals the caller to schedule a poll-loop tick as a fallback. */
    pollKick: PollKick, 
    /** Set to `true` by the owning manager during shutdown so retry
     *  loops bail promptly. */
    isShuttingDown: () => boolean, 
    /** Remembers op IDs we apply from peer-sync paths so PushHook
     *  doesn't mirror them back to the collab feed as echoes. */
    appliedOpsTracker: AppliedOpsTracker);
    /**
     * Zero-RTT apply. On failure, falls back to a poll-loop kick — the
     * caller needn't re-throw.
     */
    applyInlineOps(summary: CollabSummary, writer: string, input: InlineOpsInput): Promise<void>;
    /**
     * Fast-path apply from a GSOC ping's refs. Retries with exponential
     * backoff up to ~15s because the chunk may not have propagated yet
     * even though the ping did. Falls back to a poll-loop kick if every
     * attempt fails.
     */
    applyFromPing(summary: CollabSummary, writer: string, refs: RefsFetchInput): Promise<void>;
    /**
     * Shared tail of every apply path.
     *
     * Returns:
     *   - `true`  — ops applied (zero-length batches count as handled).
     *   - `false` — reactor not yet wired; caller should retry later.
     * Throws on `reactor.load` failures; callers decide whether to retry.
     */
    applyAndAdvance(input: ApplyInput): Promise<boolean>;
    private bumpPeerActivity;
}
//# sourceMappingURL=apply-pipeline.d.ts.map