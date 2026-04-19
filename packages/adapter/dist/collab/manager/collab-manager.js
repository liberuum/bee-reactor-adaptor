/**
 * CollabManager — public facade for live collaboration on top of Swarm.
 *
 * Orchestrates six single-purpose components:
 *
 *   • {@link SummaryStore}       — in-memory summaries + localStorage
 *   • {@link CollabEventBus}     — UI event fan-out with per-handler
 *                                  error isolation
 *   • {@link CollabLifecycle}    — create / accept / add / revoke / leave
 *                                  / refreshManifest
 *   • {@link GsocCoordinator}    — GSOC transport: mine + advertise +
 *                                  subscribe + three-tier ping fast path
 *   • {@link ApplyPipeline}      — incoming-ops fast paths (inline,
 *                                  /bzz refs, shared `reactor.load` tail)
 *   • {@link PushHook}           — mirror local pushes to collab feeds +
 *                                  lazy grantee chain for joiners
 *   • {@link PollLoop}           — 5s safety-net feed poll
 *   • {@link UserManifestSync}   — on-Swarm authoritative registry
 *                                  (rehydrate + upsert)
 *
 * This class is intentionally thin: it wires dependencies, exposes the
 * public API, and forwards calls.
 */
import { CollabOpsFeed } from "../collab-ops-feed.js";
import { ApplyPipeline } from "./apply-pipeline.js";
import { CollabEventBus } from "./event-bus.js";
import { GsocCoordinator } from "./gsoc-coordinator.js";
import { CollabLifecycle } from "./lifecycle.js";
import { PollLoop } from "./poll-loop.js";
import { PushHook } from "./push-hook.js";
import { UserManifestSync } from "./rehydrator.js";
import { SummaryStore } from "./store.js";
export class CollabManager {
    myAddress;
    store;
    events;
    opsFeed;
    applyPipeline;
    gsoc;
    pollLoop;
    pushHook;
    lifecycle;
    userManifestSync;
    shuttingDown = false;
    constructor(client, chat, myAddress, 
    /** Optional — pass a notifier to enable GSOC op-committed pings.
     *  Pre-plugin-init paths and unit tests can omit it. */
    gsoc) {
        this.myAddress = myAddress;
        const isShuttingDown = () => this.shuttingDown;
        this.store = new SummaryStore();
        this.events = new CollabEventBus();
        this.opsFeed = new CollabOpsFeed(client);
        // ApplyPipeline takes a pollKick callback so it can fall back to
        // the poll loop without a direct reference (breaks import cycles).
        const pollKick = () => this.pollLoop?.kick();
        this.applyPipeline = new ApplyPipeline(this.store, this.events, this.opsFeed, pollKick, isShuttingDown);
        this.gsoc = new GsocCoordinator(client, myAddress, gsoc ?? null, this.store, this.events, this.applyPipeline, pollKick);
        this.userManifestSync = new UserManifestSync(client, myAddress, this.store, this.events, this.gsoc);
        this.lifecycle = new CollabLifecycle(client, chat, myAddress, this.store, this.events, this.gsoc, this.userManifestSync);
        this.userManifestSync.wireManifestFeed(this.lifecycle.getManifestFeed());
        this.pollLoop = new PollLoop(this.store, this.opsFeed, this.applyPipeline, this.gsoc, myAddress, isShuttingDown);
        this.pushHook = new PushHook(client, this.opsFeed, this.store, this.gsoc, myAddress, (collabId) => this.lifecycle.refreshManifest(collabId), isShuttingDown);
        this.pollLoop.start();
        // Install the push hook so SwarmChannel can notify us on every
        // local op flush. Stable global so channels created before this
        // manager (cold start, HMR) can still find it lazily. Shut down
        // any prior instance first — HMR re-runs this constructor without
        // tearing down the previous manager, and two live PollLoops
        // competing over the same store cause intermittent failures
        // (especially when their constructor signatures diverge across
        // module versions).
        const g = globalThis;
        const prior = g.__swarmCollabManager__;
        if (prior && prior !== this) {
            try {
                prior.shutdown?.();
            }
            catch { /* best effort */ }
        }
        g.__swarmCollabManager__ = this;
        // Rehydrate from the user manifest on Swarm — authoritative source
        // of "which collabs am I in". Local summaries (localStorage) are a
        // startup cache; on a fresh browser they start empty and this
        // backfills from Swarm. Runs in background, not awaited.
        void this.userManifestSync.rehydrate();
    }
    shutdown() {
        this.shuttingDown = true;
        this.pollLoop.shutdown();
        this.gsoc.shutdown();
        const g = globalThis;
        if (g.__swarmCollabManager__ === this) {
            g.__swarmCollabManager__ = null;
        }
    }
    // ─── Collab lifecycle ──────────────────────────────────────────
    async create(input) {
        return this.lifecycle.create(input);
    }
    async accept(invite) {
        return this.lifecycle.accept(invite);
    }
    async addParticipant(collabId, peerAddress) {
        return this.lifecycle.addParticipant(collabId, peerAddress);
    }
    async revokeParticipant(collabId, peerAddress) {
        return this.lifecycle.revokeParticipant(collabId, peerAddress);
    }
    async refreshManifest(collabId) {
        return this.lifecycle.refreshManifest(collabId);
    }
    async leave(collabId) {
        return this.lifecycle.leave(collabId);
    }
    // ─── Reads ─────────────────────────────────────────────────────
    list() {
        return this.store.listByRecentActivity();
    }
    get(collabId) {
        return this.store.get(collabId);
    }
    // ─── Events ────────────────────────────────────────────────────
    on(type, handler) {
        return this.events.on(type, handler);
    }
    // ─── SwarmChannel push hook ────────────────────────────────────
    async handleLocalPush(input) {
        return this.pushHook.handleLocalPush(input);
    }
    // Expose for tests that want to drive myAddress-specific paths
    // without going through the full plugin stack. Read-only.
    getMyAddress() {
        return this.myAddress;
    }
}
//# sourceMappingURL=collab-manager.js.map