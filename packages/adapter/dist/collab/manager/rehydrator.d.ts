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
import type { CollabManifestFeed } from "../collab-manifest-feed.js";
import type { CollabSummary } from "../types.js";
import type { CollabEventBus } from "./event-bus.js";
import type { GsocCoordinator } from "./gsoc-coordinator.js";
import { SummaryStore } from "./store.js";
export declare class UserManifestSync {
    private readonly client;
    private readonly myAddress;
    private readonly store;
    private readonly events;
    private readonly gsoc;
    /** Injected lazily — CollabLifecycle owns the manifest feed so we
     *  read it through that. Using a getter avoids a constructor cycle
     *  between lifecycle and rehydrator. */
    private manifestFeed?;
    constructor(client: SwarmClient, myAddress: string, store: SummaryStore, events: CollabEventBus, gsoc: GsocCoordinator);
    /**
     * Called exactly once by CollabManager after lifecycle is built so
     * this module has a manifest-feed reader. Split from the constructor
     * to break a circular dependency between rehydrator and lifecycle.
     */
    wireManifestFeed(feed: CollabManifestFeed): void;
    /**
     * Push a summary's entry into the on-Swarm user manifest.
     * Idempotent — `ensureCollabInUserManifest` merges against the
     * existing manifest.
     */
    upsert(summary: CollabSummary): Promise<void>;
    /**
     * Boot-time recovery. Reads the user manifest's `collabs` map and
     * reconstructs local summaries for any collab that isn't already in
     * localStorage. For each entry we pull the ACT-protected manifest
     * feed to get the live participant list.
     */
    rehydrate(): Promise<void>;
    /**
     * Pull the manifest feed for a recovered entry. If the feed is
     * unreachable (revoked, or chunks haven't propagated) we stash a
     * "pending" summary so the UI shows it; a later refreshManifest call
     * will promote it.
     */
    private reconstructSummary;
    private buildPendingSummary;
    private toManifestEntry;
}
//# sourceMappingURL=rehydrator.d.ts.map