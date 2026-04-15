const NOTIFY_IDENTIFIER_PREFIX = "ph:v2:notify:";
/**
 * Convert a string to a 32-byte hex identifier.
 * Uses SHA-256 to hash the string into a deterministic 32-byte value
 * suitable for the bee-js Identifier type.
 */
async function makeIdentifierHex(value) {
    const encoded = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", encoded);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}
/**
 * Synchronous version using a simple hash for identifiers.
 * Falls back to zero-padded truncation of the input for sync contexts.
 */
function makeIdentifierHexSync(value) {
    // Use a simple deterministic hash: XOR fold the string into 32 bytes
    const bytes = new Uint8Array(32);
    const encoded = new TextEncoder().encode(value);
    for (let i = 0; i < encoded.length; i++) {
        bytes[i % 32] ^= encoded[i];
    }
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
export class GsocNotifier {
    bee;
    batchId;
    myAddress;
    /** Cache of mined signers per peer overlay (mining takes 10-30s) */
    minedSigners = new Map();
    subscriptions = new Map();
    constructor(bee, batchId, myAddress) {
        this.bee = bee;
        this.batchId = batchId;
        this.myAddress = myAddress;
    }
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
    mineSigner(targetOverlay, proximity = 12) {
        const cached = this.minedSigners.get(targetOverlay);
        if (cached)
            return cached;
        const identifierHex = makeIdentifierHexSync(`${NOTIFY_IDENTIFIER_PREFIX}${this.myAddress.toLowerCase()}`);
        const signer = this.bee.gsocMine(targetOverlay, identifierHex, proximity);
        const signerHex = typeof signer === "string"
            ? signer
            : signer.toHex?.() ?? String(signer);
        this.minedSigners.set(targetOverlay, signerHex);
        return signerHex;
    }
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
    async send(targetOverlay, notificationType, data) {
        const signerHex = this.minedSigners.get(targetOverlay);
        if (!signerHex) {
            throw new Error(`No GSOC signer mined for overlay ${targetOverlay.slice(0, 12)}. Call mineSigner() first.`);
        }
        const identifier = makeIdentifierHexSync(`${NOTIFY_IDENTIFIER_PREFIX}${this.myAddress.toLowerCase()}`);
        const notification = {
            type: notificationType,
            from: this.myAddress,
            timestamp: new Date().toISOString(),
            data,
        };
        await this.bee.gsocSend(this.batchId, signerHex, identifier, JSON.stringify(notification));
    }
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
    subscribe(peerAddress, gsocAddress, handler) {
        const identifier = makeIdentifierHexSync(`${NOTIFY_IDENTIFIER_PREFIX}${peerAddress.toLowerCase()}`);
        const existingSub = this.subscriptions.get(peerAddress);
        if (existingSub)
            existingSub.cancel();
        const sub = this.bee.gsocSubscribe(gsocAddress, identifier, {
            onMessage: (data) => {
                try {
                    const bytes = typeof data.toUint8Array === "function"
                        ? data.toUint8Array()
                        : data instanceof Uint8Array ? data : new Uint8Array(data);
                    const text = new TextDecoder().decode(bytes);
                    const notification = JSON.parse(text);
                    handler.onNotification(notification);
                }
                catch (err) {
                    handler.onError?.(err instanceof Error ? err : new Error(String(err)));
                }
            },
            onError: (error) => {
                handler.onError?.(error);
            },
            onClose: () => {
                this.subscriptions.delete(peerAddress);
                handler.onClose?.();
            },
        });
        const subscription = {
            cancel: () => {
                sub.cancel();
                this.subscriptions.delete(peerAddress);
            },
        };
        this.subscriptions.set(peerAddress, subscription);
        return subscription;
    }
    /**
     * Convenience: send a typing indicator.
     */
    async sendTyping(targetOverlay) {
        return this.send(targetOverlay, "typing");
    }
    /**
     * Convenience: send a stopped-typing indicator.
     */
    async sendStoppedTyping(targetOverlay) {
        return this.send(targetOverlay, "stopped-typing");
    }
    /**
     * Convenience: send an online presence signal.
     */
    async sendOnline(targetOverlay) {
        return this.send(targetOverlay, "presence-online");
    }
    /**
     * Convenience: send an offline presence signal.
     */
    async sendOffline(targetOverlay) {
        return this.send(targetOverlay, "presence-offline");
    }
    /**
     * Convenience: notify that a document was updated.
     */
    async sendDocUpdated(targetOverlay, documentId, driveId) {
        return this.send(targetOverlay, "doc-updated", { documentId, driveId });
    }
    /**
     * Shut down all GSOC subscriptions.
     */
    shutdown() {
        for (const sub of this.subscriptions.values()) {
            sub.cancel();
        }
        this.subscriptions.clear();
    }
}
//# sourceMappingURL=gsoc-notifier.js.map