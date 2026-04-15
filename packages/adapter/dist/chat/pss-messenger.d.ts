/**
 * PSS Messenger — 1-to-1 encrypted messaging over Swarm.
 *
 * Uses Trojan chunks: sender mines a chunk whose address falls in the
 * recipient's neighborhood. Only the recipient can decrypt. Third parties
 * see encrypted noise indistinguishable from regular Swarm traffic.
 *
 * Latency: 2-10 seconds (Trojan chunk mining + push-sync).
 * Offline delivery: messages persist as chunks until stamp TTL expires.
 * Requirement: recipient must run a FULL Bee node.
 */
import { type Bee } from "@ethersphere/bee-js";
import type { ChatMessage } from "./types.js";
export interface PssSubscription {
    cancel: () => void;
}
export interface PssMessageHandler {
    onMessage: (raw: Uint8Array) => void;
    onError: (error: Error) => void;
    onClose: () => void;
}
/**
 * Derive a deterministic PSS topic for a 1-to-1 conversation.
 * Sorting ensures both parties derive the same topic.
 */
export declare function chatTopic(addressA: string, addressB: string): string;
/**
 * Derive the PSS target prefix from an overlay address.
 * Uses up to 4 hex chars for maximum targeting precision.
 */
export declare function makeTarget(overlayAddress: string): string;
export declare class PssMessenger {
    private readonly bee;
    private readonly batchId;
    private readonly myAddress;
    private subscriptions;
    constructor(bee: Bee, batchId: string, myAddress: string);
    /**
     * Send a chat message via PSS.
     *
     * @param peerOverlay - Recipient's Bee node overlay address
     * @param peerBeeNodePubKey - Recipient's Bee node public key (for encryption)
     * @param peerAddress - Recipient's Swarm signer address (for topic derivation)
     * @param message - The message to send
     */
    send(peerOverlay: string, peerBeeNodePubKey: string, peerAddress: string, message: ChatMessage): Promise<void>;
    /**
     * Subscribe to incoming PSS messages from a specific peer.
     *
     * Opens a WebSocket connection to the Bee node's PSS subscription
     * endpoint. Messages arrive as raw bytes (decrypted by the Bee node).
     *
     * @param peerAddress - Peer's Swarm signer address (for topic derivation)
     * @param handler - Callbacks for message, error, close events
     * @returns Subscription handle with cancel() method
     */
    subscribe(peerAddress: string, handler: {
        onMessage: (message: ChatMessage) => void;
        onError?: (error: Error) => void;
        onClose?: () => void;
    }): PssSubscription;
    /**
     * Subscribe to ALL incoming PSS messages (any peer).
     * Useful for listening to new conversations.
     *
     * Uses a wildcard-like approach: subscribes to the prefix topic
     * and routes by sender address in the message.
     */
    subscribeAll(handler: {
        onMessage: (message: ChatMessage) => void;
        onError?: (error: Error) => void;
    }): PssSubscription;
    /**
     * Send an initial ping to a peer's broadcast topic.
     * This notifies them that a new conversation has started.
     */
    sendBroadcastPing(peerOverlay: string, peerBeeNodePubKey: string, peerAddress: string, introMessage: ChatMessage): Promise<void>;
    /**
     * Shut down all active PSS subscriptions.
     */
    shutdown(): void;
}
//# sourceMappingURL=pss-messenger.d.ts.map