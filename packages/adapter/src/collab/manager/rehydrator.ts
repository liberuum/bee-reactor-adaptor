/**
 * UserManifestSync — bridges local summaries with the on-Swarm user
 * manifest, which is the authoritative "which collabs am I in" record
 * that survives browser wipes.
 *
 *   • `upsert(summary)` — write/update the entry for a collab.
 *   • `rehydrate()`     — boot-time recovery: for every entry in the
 *     user manifest that isn't in local storage, pull the ACT-protected
 *     manifest feed to reconstruct a summary. Kicks GSOC provisioning
 *     and peer subscriptions for everything that ends up active.
 *
 * Non-fatal if any part fails — the user can still open the
 * Collaborate tab and re-join from a fresh invite.
 */

import type { SwarmClient } from "../../swarm-client.js";
import {
  ensureCollabInUserManifest,
  listCollabsFromUserManifest,
} from "../../channel/manifest-manager.js";
import type { UserCollabEntry } from "../../types.js";
import type { CollabManifestFeed } from "../collab-manifest-feed.js";
import type { CollabSummary } from "../types.js";
import type { CollabEventBus } from "./event-bus.js";
import type { GsocCoordinator } from "./gsoc-coordinator.js";
import { SummaryStore } from "./store.js";

export class UserManifestSync {
  /** Injected lazily — CollabLifecycle owns the manifest feed so we
   *  read it through that. Using a getter avoids a constructor cycle
   *  between lifecycle and rehydrator. */
  private manifestFeed?: CollabManifestFeed;

  constructor(
    private readonly client: SwarmClient,
    private readonly myAddress: string,
    private readonly store: SummaryStore,
    private readonly events: CollabEventBus,
    private readonly gsoc: GsocCoordinator,
  ) {}

  /**
   * Called exactly once by CollabManager after lifecycle is built so
   * this module has a manifest-feed reader. Split from the constructor
   * to break a circular dependency between rehydrator and lifecycle.
   */
  wireManifestFeed(feed: CollabManifestFeed): void {
    this.manifestFeed = feed;
  }

  /**
   * Push a summary's entry into the on-Swarm user manifest.
   * Idempotent — `ensureCollabInUserManifest` merges against the
   * existing manifest.
   */
  async upsert(summary: CollabSummary): Promise<void> {
    await ensureCollabInUserManifest(
      this.client,
      this.myAddress,
      this.toManifestEntry(summary),
    );
  }

  /**
   * Boot-time recovery. Reads the user manifest's `collabs` map and
   * reconstructs local summaries for any collab that isn't already in
   * localStorage. For each entry we pull the ACT-protected manifest
   * feed to get the live participant list.
   */
  async rehydrate(): Promise<void> {
    if (!this.manifestFeed) return;
    try {
      const registry = await listCollabsFromUserManifest(this.client, this.myAddress);
      const entries = Object.values(registry);
      if (entries.length === 0) return;

      let recovered = 0;
      for (const entry of entries) {
        if (this.store.has(entry.collabId)) continue;
        const reconstructed = await this.reconstructSummary(entry);
        this.store.set(entry.collabId, reconstructed);
        if (reconstructed.status === "active") recovered++;
      }

      if (recovered > 0) {
        console.log(
          `[CollabManager] Rehydrated ${recovered} collab(s) from user manifest.`,
        );
        // "*" is the wildcard "any collab changed" signal — CollabId is
        // a string alias so this doesn't need a cast.
        this.events.emit({ type: "collab-updated", collabId: "*" });
      }

      // Provision outbound GSOC + subscribe to peer pings for every
      // active summary. Best-effort — poll-loop covers the gap.
      for (const summary of this.store.values()) {
        if (summary.status === "pending") continue;
        void this.gsoc.provisionOutbound(summary.collabId, summary.participants).catch(() => {});
        void this.gsoc.subscribeToPeers(summary).catch(() => {});
      }
    } catch (err) {
      console.warn(
        "[CollabManager] rehydrate failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Pull the manifest feed for a recovered entry. If the feed is
   * unreachable (revoked, or chunks haven't propagated) we stash a
   * "pending" summary so the UI shows it; a later refreshManifest call
   * will promote it.
   */
  private async reconstructSummary(
    entry: UserCollabEntry,
  ): Promise<CollabSummary> {
    if (!this.manifestFeed) {
      return this.buildPendingSummary(entry);
    }
    try {
      const latest = await this.manifestFeed.readLatest(
        entry.collabId,
        entry.manifestOwnerAddress,
        entry.manifestPublisherBeeNodePubKey,
      );
      if (!latest) return this.buildPendingSummary(entry);
      const m = latest.manifest;
      return {
        collabId: entry.collabId,
        kind: entry.kind,
        driveId: entry.driveId,
        documentId: entry.documentId,
        title: m.title ?? entry.title,
        initiator: m.initiator,
        participants: m.participants.map((p) => ({
          ...p,
          address: p.address.toLowerCase(),
        })),
        manifestRef: "",
        manifestActHistoryAddress: "",
        manifestPublisherBeeNodePubKey: entry.manifestPublisherBeeNodePubKey,
        manifestFeedIndex: latest.feedIndex,
        lastActivityAt: entry.lastActivityAt,
        status: "active",
      };
    } catch (err) {
      console.warn(
        `[CollabManager] rehydrate skipped ${entry.collabId}:`,
        err instanceof Error ? err.message : err,
      );
      return this.buildPendingSummary(entry);
    }
  }

  private buildPendingSummary(entry: UserCollabEntry): CollabSummary {
    return {
      collabId: entry.collabId,
      kind: entry.kind,
      driveId: entry.driveId,
      documentId: entry.documentId,
      title: entry.title,
      initiator: entry.initiator,
      participants: [],
      manifestRef: "",
      manifestActHistoryAddress: "",
      manifestPublisherBeeNodePubKey: entry.manifestPublisherBeeNodePubKey,
      lastActivityAt: entry.lastActivityAt,
      status: "pending",
    };
  }

  private toManifestEntry(s: CollabSummary): UserCollabEntry {
    return {
      collabId: s.collabId,
      kind: s.kind,
      driveId: s.driveId,
      documentId: s.documentId,
      title: s.title,
      role: s.initiator === this.myAddress.toLowerCase() ? "initiator" : "participant",
      initiator: s.initiator,
      manifestOwnerAddress: s.initiator,
      manifestPublisherBeeNodePubKey: s.manifestPublisherBeeNodePubKey,
      joinedAt:
        s.participants.find((p) => p.address === this.myAddress.toLowerCase())?.joinedAt
        ?? new Date().toISOString(),
      lastActivityAt: s.lastActivityAt,
    };
  }
}
