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
import type { ChatMessage, ChatSession, ChatAttachment, DocumentShareAttachment, ChatEventHandler, GsocNotification } from "./types.js";
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
    /** Set of message IDs we've already emitted, to prevent duplicates when
     *  the same chunk arrives via multiple channels (broadcast + direct PSS,
     *  or Bee node re-serving cached chunks). Trimmed periodically. */
    private readonly seenMessageIds;
    /** Metadata cache for external Swarm references probed via HEAD /bzz/.
     *  Keyed by hex reference. Content is immutable so cache is never invalidated. */
    private readonly probeCache;
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
     * Read the list of chat peers previously recorded in the user manifest.
     * Used by Connect to reconstruct the conversation list on a fresh
     * browser — without this, recovery would only discover conversations
     * after the peer sends another message.
     */
    listKnownChatPeers(): Promise<string[]>;
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
     * Import a document-share attachment into the local reactor.
     *
     * Downloads the ACT-protected bundle using the attachment's references,
     * then creates a new drive (or reuses a cached one from a prior import
     * of the same share) and replays all operations.
     *
     * Idempotent: the sessionStorage cache key includes the shareReference,
     * so repeated imports of the same attachment reuse the existing drive.
     */
    importDocumentShare(attachment: DocumentShareAttachment): Promise<{
        success: boolean;
        driveId?: string;
        imported: string[];
        error?: string;
    }>;
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
     * Download a file attachment from Swarm (ACT-decrypted by Bee) and
     * return it as a Blob ready for browser rendering.
     *
     * Prefers the thumbnail reference when `thumbnail: true` is passed and a
     * thumbnail exists — callers (chat bubbles, Files tab) should pass `true`
     * for grid/preview views to keep downloads small.
     */
    downloadAttachment(attachment: import("./types.js").FileAttachment, opts?: {
        thumbnail?: boolean;
    }): Promise<Blob>;
    /**
     * Probe a Swarm reference via HEAD /bzz/<ref>/ to discover its MIME type
     * and size. Used to render previews for external (non-ACT) hashes pasted
     * into chat messages as bzz:// or /bzz/ URLs.
     *
     * Results are cached per-reference since the metadata is immutable.
     */
    probeSwarmReference(reference: string): Promise<{
        mimeType: string;
        sizeBytes: number;
        fileName?: string;
    }>;
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
    /** Per-peer pending new messages to write as a batch */
    private pendingBatches;
    /** Per-peer debounce timers for flushing batches */
    private persistTimers;
    /**
     * Queue a new message to be written to the feed as part of the next batch.
     * Debounces 3s: all messages queued within the window are written as a
     * single feed entry (page), saving feed writes during rapid typing.
     */
    queueMessageForHistory(session: ChatSession, message: ChatMessage, debounceMs?: number): void;
    /** Flush the pending batch as a new feed page. */
    private flushBatch;
    /**
     * Force-flush any pending batch for a peer.
     * Call when closing chat, switching conversations, or before unload.
     */
    flushPendingHistory(session: ChatSession): Promise<void>;
    /**
     * Load the latest N pages of history from BOTH peers' feeds.
     * Merges, dedupes by message ID, sorts chronologically.
     * Returns a cursor for loading older pages.
     *
     * @param pageCount - How many pages to load per feed (default 3)
     */
    loadHistoryLatest(session: ChatSession, pageCount?: number): Promise<import("./chat-history.js").LoadedHistory>;
    /**
     * Load older pages using a cursor from a previous load.
     */
    loadHistoryOlder(session: ChatSession, cursor: import("./chat-history.js").HistoryCursor, pageCount?: number): Promise<import("./chat-history.js").LoadedHistory>;
    /** @deprecated Use loadHistoryLatest instead */
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
    private markSeen;
}
//# sourceMappingURL=chat-manager.d.ts.map