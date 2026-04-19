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
import { GsocNotifier } from "../chat/gsoc-notifier.js";
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
    private readonly manifestFeed;
    /** Optional GSOC notifier for sub-second op-committed pings. When not
     *  provided (unit tests, pre-plugin-init), all ping paths no-op and
     *  the 5s poll timer stays as the sole transport. */
    private readonly gsoc;
    /** Per-peer mined signer: key `<collabId>:<peerAddress>`, value
     *  { signerHex, identifierHex } — stable for the life of the collab. */
    private readonly outboundGsoc;
    /** Subscription handles for pings we listen to (incoming). Key:
     *  `<collabId>:<peerAddress>`. */
    private readonly inboundGsocSubs;
    /** Signed out-of-process subscription deduper: `<collabId>:<peerAddress>`
     *  set when we have already either subscribed or failed — stops the
     *  rehydrate path from repeatedly hitting the same unreachable peer. */
    private readonly subscribedPeers;
    private pollTimer;
    private pollInFlight;
    private shuttingDown;
    constructor(client: SwarmClient, chat: ChatManager, myAddress: string, 
    /** Optional — pass a notifier to enable GSOC op-committed pings.
     *  Pre-plugin-init paths and unit tests can omit it. */
    gsoc?: GsocNotifier | null);
    shutdown(): void;
    /**
     * Create a new collaboration, invite each participant via chat, and
     * return the local summary.
     */
    create(input: CreateCollabInput): Promise<CollabSummary>;
    /**
     * Initiator-only: revoke a participant.
     *
     * Rebuilds the ACT grantee chain without that participant's Bee pubkey
     * and publishes a new manifest revision. Future op-batch writes use the
     * new chain, so the revoked peer's Bee node can no longer decrypt them.
     * Content previously accessible to them stays accessible — ACT has no
     * rewind. The revoke is about the *future*.
     */
    revokeParticipant(collabId: CollabId, peerAddress: string): Promise<CollabSummary>;
    /**
     * Initiator-only: add a participant.
     *
     * Resolves the new peer's profile, extends the ACT grantee chain via
     * patchGrantees (incremental — no rewrite), and publishes a new
     * manifest revision. The new participant receives a standard
     * invitation chat message pointing at the current bundle + manifest.
     */
    addParticipant(collabId: CollabId, peerAddress: string): Promise<CollabSummary>;
    /**
     * Re-read the collab's manifest feed to pick up any participant changes
     * the initiator has published since we last looked. Updates the local
     * summary if a newer manifest index is available.
     *
     * Returns the post-refresh summary (unchanged if no newer index).
     */
    refreshManifest(collabId: CollabId): Promise<CollabSummary | null>;
    /**
     * Accept a collab invitation received in chat. Downloads the initial
     * drive bundle via ACT, applies it to the local reactor, and records
     * the summary locally so the collab shows up in the Collaborate tab.
     */
    accept(invite: CollabInviteAttachment): Promise<CollabSummary>;
    /**
     * Record that a peer announced themselves via "collab-join". Seeds
     * peerActivity so the Manage panel can show "joined Xs ago" without
     * waiting for their first op. No-op if we already have activity for
     * this peer — real ops are strictly more informative.
     */
    private markPeerJoined;
    /**
     * Fire a best-effort "collab-join" ping to every peer in the collab.
     * Lets the initiator (and anyone else already in) flip their
     * "Awaiting" indicator to joined without needing our first edit to
     * land. Called from `accept()` after `provisionOutboundGsoc` resolves
     * so the outbound signers are mined.
     */
    private broadcastJoinedPing;
    /**
     * Stop participating in a collab on this device + strip the entry
     * from the user manifest so a fresh browser doesn't re-hydrate it.
     * The initiator's collab manifest feed is untouched — they still
     * list this user as a participant until they explicitly revoke.
     * Returns a promise so callers can await the manifest write.
     */
    leave(collabId: CollabId): Promise<void>;
    list(): CollabSummary[];
    get(collabId: CollabId): CollabSummary | undefined;
    on(type: CollabEventType | "*", handler: CollabEventHandler): () => void;
    /**
     * Mine a signer per peer for a collab, remember the listen address,
     * and merge the outbound-to-peer map into our public profile so peers
     * can find where to subscribe. Best-effort: failures are logged but
     * not thrown — the poll-loop fallback still delivers ops.
     *
     * Idempotent per (collabId, peerAddress): subsequent calls reuse the
     * cached mined signer.
     */
    private provisionOutboundGsoc;
    /**
     * Subscribe to each peer's advertised outbound-to-me GSOC address for
     * a given collab, if we haven't already. Called lazily after mining
     * completes and on rehydrate.
     */
    private subscribeToPeerGsoc;
    private handlePeerPing;
    /**
     * Zero-RTT apply: the ops arrived inline in the GSOC ping. No Swarm
     * round-trip needed — straight to reactor.load. This is the fastest
     * path, bound only by GSOC delivery (~1s cross-node) + reactor.load time.
     */
    private applyInlineOps;
    /**
     * Fast-path: apply a peer's ops directly from the refs carried in
     * a GSOC ping. Retries a few times with backoff because the /bzz
     * content chunk may not yet have propagated to our neighborhood
     * even though the ping did.
     */
    private applyFromPing;
    /**
     * Core apply pipeline shared by inline-ops, refs-fetch, and the
     * poll-loop path: unwrap OperationWithContext → reactor.load →
     * advance cursor → mark lastActivityAt → emit op-applied event.
     *
     * Returns true if ops were applied (even zero-length batches count
     * as "successfully handled"), false if the reactor isn't available.
     * Throws if reactor.load throws — callers decide whether to retry.
     */
    private applyOpsAndAdvanceCursor;
    /**
     * Send op-committed pings to every OTHER participant for a collab.
     *
     * Three-tier fast path, in order of speed:
     *   1. **Inline ops** — if the serialized ops fit within the GSOC
     *      4KB chunk budget, embed them in the ping. Receiver applies
     *      immediately with zero Swarm content fetches. Sub-second.
     *   2. **Refs only** — always include `actRef + actHistoryAddress +
     *      feedIndex` so a receiver whose ping exceeded the inline budget
     *      (or missed it) can download the batch via /bzz directly,
     *      bypassing the feed read.
     *   3. **Feed** — the actual feed write always happens in the write
     *      path. Receivers who missed both the ping entirely fall back
     *      to the poll loop that reads the feed. Recovery / fresh-browser
     *      rehydrate also reads the feed.
     *
     * Best-effort — failures don't block the personal push that already
     * succeeded.
     */
    private pingPeersForCollab;
    private summaryToUserManifestEntry;
    private upsertUserManifestEntry;
    /**
     * Boot-time recovery: read the user manifest's `collabs` map and
     * reconstruct local summaries for any collab that isn't already in
     * localStorage. For each entry we pull the ACT-protected manifest
     * feed to get the live participant list.
     *
     * Non-fatal if any part fails — the user can still open the
     * Collaborate tab and re-join from a fresh invite.
     */
    private rehydrateFromUserManifest;
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
    /** Per-collabId in-flight grantee-chain creation. Without this,
     *  two parallel handleLocalPush calls (e.g. SwarmChannel flushing
     *  two docs at once) both create a fresh chain; whoever writes
     *  summaries.set last wins, and the first writer's ops are uploaded
     *  under an orphaned chain that peers can't decrypt. */
    private readonly granteeChainInFlight;
    /**
     * Return a live ACT grantee-chain head for writes on this collab. For
     * the initiator this is just the summary's currentGranteeHistRef. For
     * joiners, this creates a chain the first time we write (lazy), using
     * the participant list from the manifest feed.
     *
     * Concurrency-safe per collabId: parallel callers await the same
     * pending chain-creation promise instead of each creating their own.
     */
    private ensureGranteeChainForLocalWrite;
    private startPolling;
    private pollOnce;
    private pollSummary;
    /**
     * Probe a single (peer, doc) feed and apply any new batches. Called
     * in parallel for each (peer, doc) tuple in a collab; the batches
     * within one tuple are applied sequentially to preserve feedIndex
     * order.
     */
    private pollPeerDoc;
    private readCursor;
    private writeCursor;
}
//# sourceMappingURL=collab-manager.d.ts.map