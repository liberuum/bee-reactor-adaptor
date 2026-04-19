/**
 * GSOC Notifier — sub-second notifications over Swarm.
 *
 * GSOC (Graffiti Single Owner Chunks) provides many-to-one notifications
 * with < 1 second latency. A signer key is mined whose SOC address falls
 * in the target node's neighborhood, then shared with writers.
 *
 * Used for: typing indicators, presence, delivery receipts,
 * document update signals, collaboration join/leave.
 *
 * Requirement: receiver must run a FULL Bee node.
 */
import type { Bee } from "@ethersphere/bee-js";
import type { GsocNotification, GsocNotificationType } from "./types.js";
export interface GsocSubscription {
    cancel: () => void;
}
export declare class GsocNotifier {
    private readonly bee;
    private readonly batchId;
    private readonly myAddress;
    /** Cache of mined signers per peer overlay (mining takes 10-30s) */
    private minedSigners;
    /** Cache for mineSignerWithIdentifier, keyed by `${overlay}:${identifierRaw}`.
     *  Mining is deterministic per (overlay, identifier) + proximity,
     *  and the output is stable — no point re-mining within a session. */
    private minedWithIdentifier;
    private subscriptions;
    constructor(bee: Bee, batchId: string, myAddress: string);
    /**
     * Mine a GSOC signer targeting a peer's overlay address.
     *
     * Mining takes 10-30 seconds. Results are cached per overlay so
     * subsequent sends are instant. Call this during session init.
     *
     * @param targetOverlay - Peer's Bee node overlay address
     * @param proximity - Mining depth (default 12 — ~1-5s mining)
     * @returns The mined signer private key (hex)
     */
    mineSigner(targetOverlay: string, proximity?: number): string;
    /**
     * Hash an identifier string into a 32-byte hex identifier. Exposed
     * so subscribers can derive the same identifier the sender mined
     * under, without paying for a fresh signer mine.
     */
    static hashIdentifier(raw: string): string;
    /**
     * Mine a GSOC signer with a caller-chosen identifier. Used by
     * subsystems (e.g. CollabManager) that need multiple independent
     * notification channels per (sender, receiver) pair — each
     * identifier produces a distinct SOC address, so chat and collab
     * pings don't cross-talk.
     *
     * Returns the signer hex and the listen address derived from the
     * signer's pubkey. The listen address is what subscribers use with
     * `gsocSubscribe`.
     */
    mineSignerWithIdentifier(targetOverlay: string, identifierRaw: string, proximity?: number): {
        signerHex: string;
        listenAddress: string;
        identifierHex: string;
    };
    /**
     * Low-level send that targets an explicit identifier + signer. Used by
     * CollabManager so multiple independent signer chains can coexist per
     * peer pair without crashing into each other via the shared mining
     * cache.
     */
    sendWithSigner(signerHex: string, identifierHex: string, notificationType: GsocNotificationType, data?: Record<string, unknown>): Promise<void>;
    /**
     * Subscribe using an explicit identifier + listen address. Mirror of
     * sendWithSigner for the receive side.
     */
    subscribeWithIdentifier(subscriptionKey: string, listenAddress: string, identifierHex: string, handler: {
        onNotification: (notification: GsocNotification) => void;
        onError?: (error: Error) => void;
        onClose?: () => void;
    }): GsocSubscription;
    /**
     * Send a notification to a peer via GSOC.
     *
     * The signer must have been mined first via `mineSigner()`.
     * Notifications are small (< 4KB) and arrive in < 1 second.
     *
     * @param targetOverlay - Peer's Bee node overlay address
     * @param notificationType - Type of notification
     * @param data - Optional payload data
     */
    send(targetOverlay: string, notificationType: GsocNotificationType, data?: Record<string, unknown>): Promise<void>;
    /**
     * Subscribe to incoming GSOC notifications from a peer.
     *
     * The peer must have mined a signer targeting OUR overlay.
     * We subscribe using the address derived from their signer.
     *
     * @param peerAddress - Peer's Swarm signer address
     * @param gsocAddress - GSOC address to listen on (from peer's mined signer)
     * @param handler - Callback for incoming notifications
     * @returns Subscription handle with cancel()
     */
    subscribe(peerAddress: string, gsocAddress: string, handler: {
        onNotification: (notification: GsocNotification) => void;
        onError?: (error: Error) => void;
        onClose?: () => void;
    }): GsocSubscription;
    /**
     * Convenience: send a typing indicator.
     */
    sendTyping(targetOverlay: string): Promise<void>;
    /**
     * Convenience: send a stopped-typing indicator.
     */
    sendStoppedTyping(targetOverlay: string): Promise<void>;
    /**
     * Convenience: send an online presence signal.
     */
    sendOnline(targetOverlay: string): Promise<void>;
    /**
     * Convenience: send an offline presence signal.
     */
    sendOffline(targetOverlay: string): Promise<void>;
    /**
     * Convenience: notify that a document was updated.
     */
    sendDocUpdated(targetOverlay: string, documentId: string, driveId: string): Promise<void>;
    /**
     * Shut down all GSOC subscriptions.
     */
    shutdown(): void;
}
//# sourceMappingURL=gsoc-notifier.d.ts.map