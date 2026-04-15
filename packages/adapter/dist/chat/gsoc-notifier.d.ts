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