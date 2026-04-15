/**
 * ChatManager — orchestrates PSS messaging, GSOC notifications,
 * and ACT-encrypted chat history for Swarm-based real-time communication.
 *
 * Usage:
 *   const chat = new ChatManager(swarmClient, bee, batchId, myAddress);
 *   const session = await chat.startSession(peerSignerAddress);
 *   await chat.sendMessage(session, "Hello!");
 *   chat.onMessage((msg) => console.log(msg));
 *   chat.shutdown();
 */
import type { Bee } from "@ethersphere/bee-js";
import type { SwarmClient } from "../swarm-client.js";
import type { ChatMessage, ChatSession, ChatAttachment, ChatEventHandler, GsocNotification } from "./types.js";
import { SwarmFile } from "./swarm-file.js";
export declare class ChatManager {
    private readonly client;
    private readonly pss;
    private readonly history;
    private readonly gsoc;
    readonly file: SwarmFile;
    private readonly sessions;
    private readonly eventHandlers;
    private readonly myAddress;
    constructor(client: SwarmClient, bee: Bee, batchId: string, myAddress: string);
    /**
     * Start a chat session with a peer.
     *
     * Resolves the peer's public profile (overlay, Bee pubkey),
     * sets up PSS subscription, and optionally mines a GSOC signer
     * for low-latency notifications.
     *
     * @param peerSignerAddress - Peer's Swarm signer address
     * @param options.skipGsoc - Skip GSOC mining (faster init, no notifications)
     * @returns The initialized chat session
     */
    startSession(peerSignerAddress: string, options?: {
        skipGsoc?: boolean;
    }): Promise<ChatSession>;
    /**
     * Get an existing session by peer address.
     */
    getSession(peerAddress: string): ChatSession | undefined;
    /**
     * List all active sessions.
     */
    listSessions(): ChatSession[];
    /**
     * Send a text message to a peer.
     *
     * Sends via PSS (encrypted, 2-10s latency) and optionally
     * sends a GSOC delivery notification (< 1s).
     */
    sendMessage(session: ChatSession, text: string, attachment?: ChatAttachment): Promise<ChatMessage>;
    /**
     * Share documents with a peer inline in the chat.
     *
     * Creates an ACT-protected share bundle and sends it as a
     * chat message with an attachment.
     */
    shareDocumentInChat(session: ChatSession, text: string, docIds: string[], driveId: string, driveName: string): Promise<ChatMessage>;
    /**
     * Share a raw file (image, audio, video, PDF, etc.) inline in chat.
     *
     * The file is uploaded to Swarm with ACT protection. For images,
     * a thumbnail is generated for inline chat preview.
     *
     * For Powerhouse document models, use shareDocumentInChat() instead.
     */
    shareFileInChat(session: ChatSession, text: string, fileData: Uint8Array | ArrayBuffer, fileName: string, mimeType: string): Promise<ChatMessage>;
    /**
     * Send a typing indicator to a peer.
     */
    sendTyping(session: ChatSession): Promise<void>;
    /**
     * Send a stopped-typing indicator.
     */
    sendStoppedTyping(session: ChatSession): Promise<void>;
    /**
     * Announce online presence to a peer.
     */
    sendOnline(session: ChatSession): Promise<void>;
    /**
     * Persist messages to the chat history feed (ACT-encrypted).
     */
    persistMessages(session: ChatSession, messages: ChatMessage[]): Promise<void>;
    /**
     * Load chat history from the peer's feed.
     */
    loadHistory(session: ChatSession): Promise<ChatMessage[]>;
    /**
     * Register a handler for chat events.
     */
    onEvent(handler: ChatEventHandler): () => void;
    /**
     * Convenience: listen for incoming messages from any peer.
     */
    onMessage(handler: (message: ChatMessage) => void): () => void;
    /**
     * Convenience: listen for GSOC notifications from any peer.
     */
    onNotification(handler: (notification: GsocNotification) => void): () => void;
    /**
     * Shut down all subscriptions and clean up.
     */
    shutdown(): void;
    private emit;
    private buildShareBundle;
}
//# sourceMappingURL=chat-manager.d.ts.map