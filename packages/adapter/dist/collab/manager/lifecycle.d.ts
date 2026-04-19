/**
 * CollabLifecycle — the high-level collab-state transitions:
 *
 *   • `create`             — bundle + ACT-upload + manifest publish + invites
 *   • `accept`             — download bundle + apply locally + record summary
 *   • `revokeParticipant`  — rotate the ACT grantee chain + new manifest
 *   • `addParticipant`     — patchGrantees + new manifest + invite
 *   • `refreshManifest`    — re-read the manifest feed for participant updates
 *   • `leave`              — drop local + strip from user manifest
 *
 * All ACT uploads follow the "sleep 1.1s between mantaray touches"
 * rule so consecutive writes don't collide on the same timestamp.
 */
import type { ChatManager } from "../../chat/chat-manager.js";
import type { SwarmClient } from "../../swarm-client.js";
import type { CollabId, CollabInviteAttachment, CollabSummary } from "../types.js";
import { CollabManifestFeed } from "../collab-manifest-feed.js";
import type { CollabEventBus } from "./event-bus.js";
import type { GsocCoordinator } from "./gsoc-coordinator.js";
import { SummaryStore } from "./store.js";
import type { UserManifestSync } from "./rehydrator.js";
export interface CreateCollabInput {
    target: {
        driveId: string;
        documentId?: string;
    };
    participants: string[];
    caption?: string;
}
export declare class CollabLifecycle {
    private readonly client;
    private readonly chat;
    private readonly myAddress;
    private readonly store;
    private readonly events;
    private readonly gsoc;
    private readonly userManifestSync;
    private readonly manifestFeed;
    constructor(client: SwarmClient, chat: ChatManager, myAddress: string, store: SummaryStore, events: CollabEventBus, gsoc: GsocCoordinator, userManifestSync: UserManifestSync);
    /**
     * Exposed so push-hook can re-read the manifest when lazily building
     * a grantee chain for a joiner. Returning the feed from a sibling
     * module would leak internal state — route through here instead.
     */
    refreshManifest(collabId: CollabId): Promise<CollabSummary | null>;
    /**
     * Reader used by the rehydrator. Kept here so the manifest feed
     * stays a single-owner resource scoped to this module.
     */
    getManifestFeed(): CollabManifestFeed;
    create(input: CreateCollabInput): Promise<CollabSummary>;
    accept(invite: CollabInviteAttachment): Promise<CollabSummary>;
    /**
     * Download the initial bundle with retry — Swarm chunks take a few
     * seconds to propagate after upload, matching the chat-share import
     * behavior.
     */
    private downloadInitialBundle;
    /**
     * Try the authoritative manifest feed first; fall back to the
     * invite's slim participant list if the feed isn't reachable yet
     * (chunk not propagated).
     */
    private resolveAcceptParticipants;
    /**
     * Initiator-only: revoke a participant.
     *
     * Rebuilds the ACT grantee chain without that participant's Bee pubkey
     * and publishes a new manifest revision. Future op-batch writes use
     * the new chain, so the revoked peer's Bee node can no longer decrypt
     * them. Content previously accessible to them stays accessible — ACT
     * has no rewind. Revoke is about the *future*.
     */
    revokeParticipant(collabId: CollabId, peerAddress: string): Promise<CollabSummary>;
    /**
     * Initiator-only: add a participant.
     *
     * Resolves the new peer's profile, extends the ACT grantee chain via
     * `patchGrantees` (incremental — no rewrite), and publishes a new
     * manifest revision. The new participant receives a standard
     * invitation chat message pointing at the current bundle + manifest.
     */
    addParticipant(collabId: CollabId, peerAddress: string): Promise<CollabSummary>;
    /**
     * Stop participating in a collab on this device + strip the entry
     * from the user manifest so a fresh browser doesn't re-hydrate it.
     * The initiator's collab manifest feed is untouched — they still
     * list this user as a participant until they explicitly revoke.
     */
    leave(collabId: CollabId): Promise<void>;
    private requireInitiatorOnly;
    private buildManifestRevision;
    private resolveParticipantProfiles;
}
//# sourceMappingURL=lifecycle.d.ts.map