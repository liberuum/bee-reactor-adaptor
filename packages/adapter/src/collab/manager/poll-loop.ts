/**
 * PollLoop — the safety-net poll that reads every peer's collab ops
 * feed on a 5-second tick. GSOC pings are the primary real-time
 * delivery path; the poll catches anything that fell through (ping
 * lost, cold-start rehydrate, peer re-publishing old batches).
 */

import type { CollabOpsFeed } from "../collab-ops-feed.js";
import type { CollabParticipant, CollabSummary } from "../types.js";
import type { ApplyPipeline } from "./apply-pipeline.js";
import { POLL_INTERVAL_MS, POLL_WARMUP_MS } from "./constants.js";
import type { GsocCoordinator } from "./gsoc-coordinator.js";
import {
  getReactorClient,
  listDocIdsInDrive,
} from "./reactor-bridge.js";
import { SummaryStore } from "./store.js";

/** How long to cache "this peer's feed for this doc doesn't exist yet"
 *  before re-probing. Prevents the 5s poll from spamming 404s against
 *  every (peer, doc) on drive-level collabs where peers have only
 *  written to a subset of docs. Cleared on any incoming GSOC ping for
 *  the peer (handled by ApplyPipeline via cursor bump). */
const FEED_404_TTL_MS = 60_000;

export class PollLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  /** Key `<collabId>:<peerAddress>:<docId>` → timestamp of last 404. */
  private readonly notFoundAt = new Map<string, number>();

  constructor(
    private readonly store: SummaryStore,
    private readonly opsFeed: CollabOpsFeed,
    private readonly applyPipeline: ApplyPipeline,
    private readonly gsoc: GsocCoordinator,
    private readonly myAddress: string,
    private readonly isShuttingDown: () => boolean,
  ) {}

  start(): void {
    if (this.timer) return;
    setTimeout(() => { void this.tick(); }, POLL_WARMUP_MS);
    this.timer = setInterval(() => { void this.tick(); }, POLL_INTERVAL_MS);
  }

  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Fire a single poll tick now. Used both by the interval and as the
   * fallback when a GSOC fast-path fails — wraps tick() so in-flight
   * dedup applies.
   */
  kick(): void {
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.isShuttingDown()) return;
    if (this.inFlight) return;
    if (this.store.size === 0) return;
    this.inFlight = true;
    try {
      for (const summary of this.store.values()) {
        if (this.isShuttingDown()) break;
        await this.pollSummary(summary);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async pollSummary(summary: CollabSummary): Promise<void> {
    if (!getReactorClient()) return;

    // Opportunistic re-mine + re-subscribe. Three silent-failure
    // windows this catches:
    //
    //  1. `provisionOutbound` at accept/create time reads our own
    //     profile first; if the plugin hasn't published it yet (race
    //     with plugin init), provisioning bails and never retries.
    //     Without this tick, our outbound-to-peer map stays missing
    //     and peers can't subscribe to our pings.
    //
    //  2. On create, the initiator's `subscribeToPeers` runs before
    //     the joiner has accepted, so the listen address isn't yet
    //     in the joiner's profile. Retrying each tick catches them
    //     within ~5s of their accept completing.
    //
    //  3. On rehydrate, if a peer's profile was unreachable (stamp
    //     lookup blip, chunk not propagated), we want to retry.
    //
    // Both methods are internally idempotent — `outbound` and
    // `subscribedPeers` dedup completed work — so the tick is cheap.
    void this.gsoc.provisionOutbound(summary.collabId, summary.participants).catch(() => {});
    void this.gsoc.subscribeToPeers(summary).catch(() => {});

    const docIds = summary.kind === "document" && summary.documentId
      ? [summary.documentId]
      : await listDocIdsInDrive(summary.driveId);
    // Include the drive itself for drive-level ops (ADD_FOLDER, MOVE_NODE).
    if (summary.kind === "drive" && !docIds.includes(summary.driveId)) {
      docIds.unshift(summary.driveId);
    }

    // Parallelize the per-(doc, peer) probes. Feed reads + ACT decrypts
    // are network-bound and mostly independent; running them in parallel
    // scales linearly with peer count. Applied ops for a SINGLE
    // (peer, doc) still sequence in feedIndex order via pollPeerDoc's
    // inner loop — only the outer fan-out parallelizes.
    const jobs: Array<Promise<void>> = [];
    for (const docId of docIds) {
      for (const participant of summary.participants) {
        if (participant.address === this.myAddress.toLowerCase()) continue;
        if (!participant.beeNodePublicKey) continue;
        jobs.push(this.pollPeerDoc(summary, docId, participant));
      }
    }
    await Promise.all(jobs);
  }

  /**
   * Probe a single (peer, doc) feed and apply any new batches. Called
   * in parallel for each (peer, doc) tuple in a collab; the batches
   * within one tuple are applied sequentially to preserve feedIndex
   * order.
   */
  private async pollPeerDoc(
    summary: CollabSummary,
    docId: string,
    participant: CollabParticipant,
  ): Promise<void> {
    try {
      // Suppress repeated 404s for feeds we've recently discovered
      // don't exist. Drive-level collabs probe every (peer, doc) combo
      // every 5s; without this, browsers log failed fetches from peers
      // who've only written to a subset of docs. A pending ping clears
      // the cache implicitly by bumping the cursor (see below).
      const key = notFoundKey(summary.collabId, participant.address, docId);
      const cursor = this.store.readCursor(
        summary.collabId,
        participant.address,
        docId,
      );
      if (cursor > 0) {
        // Once we've ever applied ops for this (peer, doc) the feed
        // definitely exists — drop any stale 404 marker and always poll.
        this.notFoundAt.delete(key);
      } else {
        const lastMiss = this.notFoundAt.get(key);
        if (lastMiss && Date.now() - lastMiss < FEED_404_TTL_MS) return;
      }

      const latest = await this.opsFeed.getLatestIndex(
        summary.collabId,
        summary.driveId,
        docId,
        participant.address,
      );
      if (latest == null) {
        this.notFoundAt.set(key, Date.now());
        return;
      }
      this.notFoundAt.delete(key);

      if (latest < cursor) return;

      const batches = await this.opsFeed.readRange(
        summary.collabId,
        summary.driveId,
        docId,
        participant.address,
        cursor,
        latest,
        participant.beeNodePublicKey,
      );
      if (batches.length === 0) return;

      for (const { feedIndex, batch } of batches) {
        try {
          await this.applyPipeline.applyAndAdvance({
            collabId: summary.collabId,
            writer: participant.address,
            docId,
            branch: batch.branch ?? "main",
            ops: JSON.parse(batch.opsJson),
            feedIndex,
          });
        } catch (err) {
          console.warn(
            `[CollabManager] apply ops failed (${summary.collabId}, doc ${docId.slice(0, 8)}, idx ${feedIndex}):`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      // Peer's feed may not exist yet (they haven't made any edits).
      // Log at debug level so unexpected errors are still visible.
      console.debug(
        `[CollabManager] pollSummary peer ${participant.address.slice(0, 10)} skipped:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

function notFoundKey(
  collabId: string,
  peerAddress: string,
  docId: string,
): string {
  return `${collabId}:${peerAddress}:${docId}`;
}
