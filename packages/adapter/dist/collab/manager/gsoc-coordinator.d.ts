/**
 * GsocCoordinator — owns everything about the GSOC transport for a
 * collab:
 *
 *   • Mines one signer per (collab, peer) pair targeting the peer's
 *     overlay neighbourhood and advertises the resulting listen address
 *     on the sender's public profile.
 *   • Subscribes to each peer's advertised outbound-to-me channel so we
 *     hear their pings.
 *   • Dispatches incoming pings to `ApplyPipeline` (inline / refs fast
 *     paths) or to `pollKick` (fallback) and handles the "collab-join"
 *     announce ping that seeds `peerActivity`.
 *   • Sends outbound pings — both op-committed (`doc-updated`, with the
 *     three-tier inline/refs/feed fast path) and the one-shot
 *     announce-only `collab-join`.
 */
import type { SwarmClient } from "../../swarm-client.js";
import { GsocNotifier } from "../../chat/gsoc-notifier.js";
import type { CollabId, CollabParticipant, CollabSummary } from "../types.js";
import type { ApplyPipeline, PollKick } from "./apply-pipeline.js";
import type { CollabEventBus } from "./event-bus.js";
import { SummaryStore } from "./store.js";
export interface OpCommittedWrite {
    actRef: string;
    actHistoryAddress: string;
    feedIndex: number;
    /** Raw OperationWithContext[] — will be inlined if the ping fits.
     *  Readonly because the caller shouldn't mutate it and we don't. */
    ops?: readonly unknown[];
    scope?: string;
    branch?: string;
}
export declare class GsocCoordinator {
    private readonly client;
    private readonly myAddress;
    /** May be null in unit tests or pre-init — all ping paths no-op. */
    private readonly gsoc;
    private readonly store;
    private readonly events;
    private readonly applyPipeline;
    private readonly pollKick;
    /** Per-peer mined signer: key `<collabId>:<peerAddress>`, value
     *  { signerHex, identifierHex } — stable for the life of the collab. */
    private readonly outbound;
    /** Subscription cancel handles for inbound pings. Key:
     *  `<collabId>:<peerAddress>`. */
    private readonly inboundSubs;
    /** Per-subscription deduper — set when we've either subscribed OR
     *  failed so rehydrate won't loop on unreachable peers. Cleared on
     *  retryable failures so the next rehydrate tick can try again. */
    private readonly subscribedPeers;
    constructor(client: SwarmClient, myAddress: string, 
    /** May be null in unit tests or pre-init — all ping paths no-op. */
    gsoc: GsocNotifier | null, store: SummaryStore, events: CollabEventBus, applyPipeline: ApplyPipeline, pollKick: PollKick);
    shutdown(): void;
    /**
     * Mine a signer per peer for a collab, remember the listen address,
     * and merge the outbound-to-peer map into our public profile so peers
     * can find where to subscribe. Best-effort: failures are logged but
     * not thrown — the poll-loop fallback still delivers ops.
     *
     * Idempotent per (collabId, peerAddress): subsequent calls reuse the
     * cached mined signer.
     */
    provisionOutbound(collabId: CollabId, peers: CollabParticipant[]): Promise<void>;
    /**
     * Subscribe to each peer's advertised outbound-to-me GSOC address for
     * a given collab, if we haven't already. Called lazily after mining
     * completes and on rehydrate.
     */
    subscribeToPeers(summary: CollabSummary): Promise<void>;
    /**
     * Send op-committed pings to every OTHER participant for a collab.
     *
     * Three-tier fast path:
     *   1. **Inline ops** — if the serialized ops fit within the GSOC
     *      4KB chunk budget, embed them in the ping (sub-second apply,
     *      zero Swarm fetches).
     *   2. **Refs only** — always include `actRef + actHistoryAddress +
     *      feedIndex` so a receiver whose ping exceeded the inline budget
     *      can download the batch via /bzz directly.
     *   3. **Feed** — the actual feed write happens in the push path.
     *      Receivers who missed the ping entirely fall back to the poll
     *      loop that reads the feed.
     */
    pingOpCommitted(summary: CollabSummary, driveId: string, docId: string, write?: OpCommittedWrite): Promise<void>;
    /**
     * Fire a best-effort "collab-join" announce ping to every peer. Lets
     * peers already in the collab flip their "Awaiting" indicator to
     * joined without needing our first edit to land. Called from accept()
     * after `provisionOutbound` resolves so the outbound signers are mined.
     */
    broadcastJoined(summary: CollabSummary): Promise<void>;
    /**
     * Dispatch an incoming GSOC notification for a collab. Public so
     * unit tests can simulate pings without standing up a real Swarm
     * subscription; production callers reach here via the
     * `subscribeWithIdentifier` callback wired up in `subscribeToPeers`.
     */
    handlePing(summary: CollabSummary, writerAddress: string, notification: unknown): void;
    /**
     * Record that a peer announced themselves via "collab-join". Seeds
     * `peerActivity` so the Manage panel can show "joined Xs ago"
     * without waiting for their first op. No-op if we already have
     * activity for this peer — real ops are strictly more informative.
     */
    private markPeerJoined;
    private isSelf;
    private lookupOverlay;
}
//# sourceMappingURL=gsoc-coordinator.d.ts.map