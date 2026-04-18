/**
 * CollabManager — orchestrates live collaboration setup on top of Swarm.
 *
 * MVP scope (Milestone 1 in live-collaboration-design.md):
 *   - `create()` builds the initial drive bundle, uploads it ACT-protected
 *     with every participant's Bee node pubkey as a grantee, and sends a
 *     chat-message invitation to each participant.
 *   - `accept()` imports the bundle via the existing share-import pipeline
 *     and records a local summary in localStorage so the user sees the
 *     collab in the Collaborate tab across reloads.
 *   - `list()` returns the active summaries; `leave()` removes one locally.
 *
 * Out of scope for M1 (Milestone 2+):
 *   - SwarmChannel peer-feed registration & dual push path to collab-scoped
 *     ACT feeds (handled separately — this manager just persists "who's
 *     participating" and emits events so the rest of the stack can wire up).
 *   - Collab-manifest feed with participant add/remove after invite time.
 *   - GSOC `op-committed` pings for real-time pulls.
 */
import type { SwarmClient } from "../swarm-client.js";
import type { ChatManager } from "../chat/chat-manager.js";
import type { CollabEventHandler, CollabEventType, CollabId, CollabSummary, CollabInviteAttachment } from "./types.js";
export interface CreateCollabInput {
    target: {
        driveId: string;
        documentId?: string;
    };
    participants: string[];
    caption?: string;
}
export declare class CollabManager {
    private readonly client;
    private readonly chat;
    private readonly myAddress;
    private readonly summaries;
    private readonly handlers;
    private readonly opsFeed;
    private pollTimer;
    private pollInFlight;
    private shuttingDown;
    constructor(client: SwarmClient, chat: ChatManager, myAddress: string);
    shutdown(): void;
    /**
     * Create a new collaboration, invite each participant via chat, and
     * return the local summary.
     */
    create(input: CreateCollabInput): Promise<CollabSummary>;
    /**
     * Accept a collab invitation received in chat. Downloads the initial
     * drive bundle via ACT, applies it to the local reactor, and records
     * the summary locally so the collab shows up in the Collaborate tab.
     */
    accept(invite: CollabInviteAttachment): Promise<CollabSummary>;
    /**
     * Locally stop participating in a collab. M1 is local-only: we clear
     * the summary so pulls + UI stop. The initiator still lists this user
     * in their manifest until they rewrite it.
     */
    leave(collabId: CollabId): void;
    list(): CollabSummary[];
    get(collabId: CollabId): CollabSummary | undefined;
    on(type: CollabEventType | "*", handler: CollabEventHandler): () => void;
    private emit;
    private persist;
    private loadFromStorage;
    /**
     * List doc IDs in a drive by reading the reactor's local state. Falls
     * back to an empty list if the reactor client isn't wired up.
     */
    private listDocIdsInDrive;
    /**
     * Called by SwarmChannel after a successful push of local ops to the
     * user's personal doc feed. Mirrors the same batch to each active
     * collab's ACT-protected per-peer feed so other participants can see
     * the ops.
     *
     * Best-effort: errors are logged but don't fail the caller — the
     * personal-feed push already succeeded, the collab mirror is a
     * secondary write that can be retried on next push.
     */
    handleLocalPush(input: {
        driveId: string;
        docId: string;
        ops: any[];
        scope: string;
        branch: string;
    }): Promise<void>;
    private startPolling;
    private pollOnce;
    private pollSummary;
    private readCursor;
    private writeCursor;
}
//# sourceMappingURL=collab-manager.d.ts.map