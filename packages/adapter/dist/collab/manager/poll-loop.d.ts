/**
 * PollLoop — the safety-net poll that reads every peer's collab ops
 * feed on a 5-second tick. GSOC pings are the primary real-time
 * delivery path; the poll catches anything that fell through (ping
 * lost, cold-start rehydrate, peer re-publishing old batches).
 */
import type { CollabOpsFeed } from "../collab-ops-feed.js";
import type { ApplyPipeline } from "./apply-pipeline.js";
import type { GsocCoordinator } from "./gsoc-coordinator.js";
import { SummaryStore } from "./store.js";
export declare class PollLoop {
    private readonly store;
    private readonly opsFeed;
    private readonly applyPipeline;
    private readonly gsoc;
    private readonly myAddress;
    private readonly isShuttingDown;
    private timer;
    private inFlight;
    /** Key `<collabId>:<peerAddress>:<docId>` → timestamp of last 404. */
    private readonly notFoundAt;
    constructor(store: SummaryStore, opsFeed: CollabOpsFeed, applyPipeline: ApplyPipeline, gsoc: GsocCoordinator, myAddress: string, isShuttingDown: () => boolean);
    start(): void;
    shutdown(): void;
    /**
     * Fire a single poll tick now. Used both by the interval and as the
     * fallback when a GSOC fast-path fails — wraps tick() so in-flight
     * dedup applies.
     */
    kick(): void;
    private tick;
    private pollSummary;
    /**
     * Probe a single (peer, doc) feed and apply any new batches. Called
     * in parallel for each (peer, doc) tuple in a collab; the batches
     * within one tuple are applied sequentially to preserve feedIndex
     * order.
     */
    private pollPeerDoc;
}
//# sourceMappingURL=poll-loop.d.ts.map