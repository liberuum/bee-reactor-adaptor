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

import type { SwarmClient } from "../../swarm-client.js";
import type { ChatManager } from "../../chat/chat-manager.js";
import { GsocNotifier } from "../../chat/gsoc-notifier.js";
import { CollabOpsFeed } from "../collab-ops-feed.js";
import type {
  CollabEventHandler,
  CollabEventType,
  CollabId,
  CollabInviteAttachment,
  CollabSummary,
} from "../types.js";
import { ApplyPipeline } from "./apply-pipeline.js";
import { CollabEventBus } from "./event-bus.js";
import { CollabFeedFlusher } from "./feed-flusher.js";
import { GsocCoordinator } from "./gsoc-coordinator.js";
import type { CollabManagerHook } from "./host-types.js";
import { CollabLifecycle, type CreateCollabInput } from "./lifecycle.js";
import { PollLoop } from "./poll-loop.js";
import { PushHook, type LocalPushInput } from "./push-hook.js";
import { UserManifestSync } from "./rehydrator.js";
import { SummaryStore } from "./store.js";

/** SwarmChannel finds the manager via this global to avoid a direct
 *  import (handles HMR + cold-start ordering). */
interface CollabGlobal {
  __swarmCollabManager__?: CollabManagerHook | null;
}

export type { CreateCollabInput } from "./lifecycle.js";

export class CollabManager {
  private readonly store: SummaryStore;
  private readonly events: CollabEventBus;
  private readonly opsFeed: CollabOpsFeed;
  private readonly applyPipeline: ApplyPipeline;
  private readonly gsoc: GsocCoordinator;
  private readonly pollLoop: PollLoop;
  private readonly pushHook: PushHook;
  private readonly flusher: CollabFeedFlusher;
  private readonly lifecycle: CollabLifecycle;
  private readonly userManifestSync: UserManifestSync;

  private shuttingDown = false;

  constructor(
    client: SwarmClient,
    chat: ChatManager,
    private readonly myAddress: string,
    /** Optional — pass a notifier to enable GSOC op-committed pings.
     *  Pre-plugin-init paths and unit tests can omit it. */
    gsoc?: GsocNotifier | null,
  ) {
    const isShuttingDown = () => this.shuttingDown;

    this.store = new SummaryStore();
    this.events = new CollabEventBus();
    this.opsFeed = new CollabOpsFeed(client);

    // ApplyPipeline takes a pollKick callback so it can fall back to
    // the poll loop without a direct reference (breaks import cycles).
    const pollKick = () => this.pollLoop?.kick();
    this.applyPipeline = new ApplyPipeline(
      this.store,
      this.events,
      this.opsFeed,
      pollKick,
      isShuttingDown,
    );

    this.gsoc = new GsocCoordinator(
      client,
      myAddress,
      gsoc ?? null,
      this.store,
      this.events,
      this.applyPipeline,
      pollKick,
    );

    this.userManifestSync = new UserManifestSync(
      client,
      myAddress,
      this.store,
      this.events,
      this.gsoc,
    );

    this.lifecycle = new CollabLifecycle(
      client,
      chat,
      myAddress,
      this.store,
      this.events,
      this.gsoc,
      this.userManifestSync,
    );
    this.userManifestSync.wireManifestFeed(this.lifecycle.getManifestFeed());

    this.pollLoop = new PollLoop(
      this.store,
      this.opsFeed,
      this.applyPipeline,
      this.gsoc,
      myAddress,
      isShuttingDown,
    );

    // Feed writes are debounced through this flusher — the reason
    // chat is reliable (see ChatManager.queueMessageForHistory). Every
    // local push queues here, a 1.5s timer coalesces bursts into one
    // ACT write, and the ping fires after the write with a valid
    // `actRef`. Kills the mantaray-1-sec-bucket race that was silently
    // dropping batches under rapid typing.
    this.flusher = new CollabFeedFlusher(
      client,
      this.opsFeed,
      this.store,
      this.gsoc,
      (collabId) => this.lifecycle.refreshManifest(collabId),
    );

    this.pushHook = new PushHook(
      this.store,
      this.flusher,
      myAddress,
      isShuttingDown,
    );

    this.pollLoop.start();

    // Install the push hook so SwarmChannel can notify us on every
    // local op flush. Stable global so channels created before this
    // manager (cold start, HMR) can still find it lazily. Shut down
    // any prior instance first — HMR re-runs this constructor without
    // tearing down the previous manager, and two live PollLoops
    // competing over the same store cause intermittent failures
    // (especially when their constructor signatures diverge across
    // module versions).
    const g = globalThis as unknown as CollabGlobal;
    const prior = g.__swarmCollabManager__;
    if (prior && prior !== (this as unknown as CollabManagerHook)) {
      try {
        (prior as { shutdown?: () => void }).shutdown?.();
      } catch { /* best effort */ }
    }
    g.__swarmCollabManager__ = this;

    // Rehydrate from the user manifest on Swarm — authoritative source
    // of "which collabs am I in". Local summaries (localStorage) are a
    // startup cache; on a fresh browser they start empty and this
    // backfills from Swarm. Runs in background, not awaited.
    void this.userManifestSync.rehydrate();
  }

  /**
   * Stop timers, detach the global hook, and drain pending debounced
   * feed writes. Async so callers can `await shutdown()` when they
   * need to be sure queued ops have landed (e.g. `beforeunload`
   * handlers). Timers are stopped first so they can't fire during or
   * after the flush; the flush is best-effort (shutdown can't block
   * on network).
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.pollLoop.shutdown();
    this.gsoc.shutdown();
    const g = globalThis as unknown as CollabGlobal;
    if (g.__swarmCollabManager__ === (this as unknown as CollabManagerHook)) {
      g.__swarmCollabManager__ = null;
    }
    try {
      await this.flusher.flushAll();
    } catch { /* best effort */ }
  }

  // ─── Collab lifecycle ──────────────────────────────────────────

  async create(input: CreateCollabInput): Promise<CollabSummary> {
    return this.lifecycle.create(input);
  }

  async accept(invite: CollabInviteAttachment): Promise<CollabSummary> {
    return this.lifecycle.accept(invite);
  }

  async addParticipant(
    collabId: CollabId,
    peerAddress: string,
  ): Promise<CollabSummary> {
    return this.lifecycle.addParticipant(collabId, peerAddress);
  }

  async revokeParticipant(
    collabId: CollabId,
    peerAddress: string,
  ): Promise<CollabSummary> {
    return this.lifecycle.revokeParticipant(collabId, peerAddress);
  }

  async refreshManifest(collabId: CollabId): Promise<CollabSummary | null> {
    return this.lifecycle.refreshManifest(collabId);
  }

  async leave(collabId: CollabId): Promise<void> {
    return this.lifecycle.leave(collabId);
  }

  // ─── Reads ─────────────────────────────────────────────────────

  list(): CollabSummary[] {
    return this.store.listByRecentActivity();
  }

  get(collabId: CollabId): CollabSummary | undefined {
    return this.store.get(collabId);
  }

  // ─── Events ────────────────────────────────────────────────────

  on(
    type: CollabEventType | "*",
    handler: CollabEventHandler,
  ): () => void {
    return this.events.on(type, handler);
  }

  // ─── SwarmChannel push hook ────────────────────────────────────

  async handleLocalPush(input: LocalPushInput): Promise<void> {
    return this.pushHook.handleLocalPush(input);
  }

  // Expose for tests that want to drive myAddress-specific paths
  // without going through the full plugin stack. Read-only.
  getMyAddress(): string {
    return this.myAddress;
  }
}
