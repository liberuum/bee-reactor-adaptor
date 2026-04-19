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
import type { CollabEventHandler, CollabEventType, CollabId, CollabInviteAttachment, CollabSummary } from "../types.js";
import { type CreateCollabInput } from "./lifecycle.js";
import { type LocalPushInput } from "./push-hook.js";
export type { CreateCollabInput } from "./lifecycle.js";
export declare class CollabManager {
    private readonly myAddress;
    private readonly store;
    private readonly events;
    private readonly opsFeed;
    private readonly applyPipeline;
    private readonly gsoc;
    private readonly pollLoop;
    private readonly pushHook;
    private readonly lifecycle;
    private readonly userManifestSync;
    private shuttingDown;
    constructor(client: SwarmClient, chat: ChatManager, myAddress: string, 
    /** Optional — pass a notifier to enable GSOC op-committed pings.
     *  Pre-plugin-init paths and unit tests can omit it. */
    gsoc?: GsocNotifier | null);
    shutdown(): void;
    create(input: CreateCollabInput): Promise<CollabSummary>;
    accept(invite: CollabInviteAttachment): Promise<CollabSummary>;
    addParticipant(collabId: CollabId, peerAddress: string): Promise<CollabSummary>;
    revokeParticipant(collabId: CollabId, peerAddress: string): Promise<CollabSummary>;
    refreshManifest(collabId: CollabId): Promise<CollabSummary | null>;
    leave(collabId: CollabId): Promise<void>;
    list(): CollabSummary[];
    get(collabId: CollabId): CollabSummary | undefined;
    on(type: CollabEventType | "*", handler: CollabEventHandler): () => void;
    handleLocalPush(input: LocalPushInput): Promise<void>;
    getMyAddress(): string;
}
//# sourceMappingURL=collab-manager.d.ts.map