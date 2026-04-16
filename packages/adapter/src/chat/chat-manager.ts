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
import type {
  ChatMessage,
  ChatSession,
  ChatAttachment,
  DocumentShareAttachment,
  FileAttachment,
  ChatEvent,
  ChatEventHandler,
  GsocNotification,
} from "./types.js";
import { PssMessenger, chatTopic } from "./pss-messenger.js";
import { ChatHistory, historyTopic } from "./chat-history.js";
import { GsocNotifier } from "./gsoc-notifier.js";
import { SwarmFile } from "./swarm-file.js";

export class ChatManager {
  private readonly pss: PssMessenger;
  private readonly history: ChatHistory;
  private readonly gsoc: GsocNotifier;
  readonly file: SwarmFile;
  private readonly sessions = new Map<string, ChatSession>();
  private readonly eventHandlers = new Set<ChatEventHandler>();
  private readonly myAddress: string;
  /** Set of message IDs we've already emitted, to prevent duplicates when
   *  the same chunk arrives via multiple channels (broadcast + direct PSS,
   *  or Bee node re-serving cached chunks). Trimmed periodically. */
  private readonly seenMessageIds = new Set<string>();

  /** Metadata cache for external Swarm references probed via HEAD /bzz/.
   *  Keyed by hex reference. Content is immutable so cache is never invalidated. */
  private readonly probeCache = new Map<string, { mimeType: string; sizeBytes: number; fileName?: string }>();

  constructor(
    private readonly client: SwarmClient,
    bee: Bee,
    batchId: string,
    myAddress: string,
  ) {
    this.myAddress = myAddress;
    this.pss = new PssMessenger(bee, batchId, myAddress);
    this.history = new ChatHistory(client, myAddress);
    this.gsoc = new GsocNotifier(bee, batchId, myAddress);
    this.file = new SwarmFile(client);

    // Auto-subscribe to broadcast topic so we discover new conversations.
    // When another user sends us a message for the first time, they also
    // send a ping to our broadcast topic. We auto-create a session and
    // subscribe to the direct topic so we receive their messages.
    this.pss.subscribeAll({
      onMessage: (message) => {
        // Deduplicate SYNCHRONOUSLY. Bee may re-serve the same cached chunk
        // multiple times in rapid succession; if we wait until after the
        // async startSession to mark it seen, parallel deliveries all race
        // past the check.
        if (this.seenMessageIds.has(message.id)) return;
        this.markSeen(message.id);

        console.log(`[Chat] Broadcast ping from ${message.from.slice(0, 10)}: "${message.text.slice(0, 30)}"`);
        // Auto-create session with the sender so we start receiving their messages
        this.startSession(message.from, { skipGsoc: true })
          .then(() => {
            this.emit({ type: "message-received", data: message });
          })
          .catch((err) => {
            console.warn(`[Chat] Auto-session for ${message.from.slice(0, 10)} failed:`, err);
          });
      },
      onError: (err) => {
        console.warn("[Chat] Broadcast subscription error:", err.message);
      },
    });
    console.log("[Chat] Listening for new conversations on broadcast topic");
  }

  // ─── Session Management ──────────────────────────────────────

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
  async startSession(
    peerSignerAddress: string,
    options?: { skipGsoc?: boolean },
  ): Promise<ChatSession> {
    const existing = this.sessions.get(peerSignerAddress);
    if (existing?.ready) return existing;

    // Resolve peer's public profile
    const profile = await this.client.readPublicProfile(peerSignerAddress);
    if (!profile) {
      throw new Error(
        `No Swarm profile found for ${peerSignerAddress.slice(0, 10)}…${peerSignerAddress.slice(-4)}. ` +
        `Make sure you're using their Swarm ID (not wallet address). ` +
        `They can find their Swarm ID in Swarm Settings → Your Swarm ID.`,
      );
    }
    if (!profile.beeNodePublicKey || !profile.overlayAddress) {
      throw new Error(
        `Peer's profile is incomplete (missing Bee node public key or overlay). ` +
        `Ask them to reconnect their Swarm node.`,
      );
    }

    const session: ChatSession = {
      peerAddress: peerSignerAddress,
      peerOverlay: profile.overlayAddress,
      peerBeeNodePubKey: profile.beeNodePublicKey,
      peerDisplayName: profile.ethAddress,
      pssTopic: chatTopic(this.myAddress, peerSignerAddress),
      historyTopic: historyTopic(this.myAddress, peerSignerAddress),
      ready: false,
      lastActivity: new Date().toISOString(),
    };

    // Subscribe to incoming PSS messages from this peer
    this.pss.subscribe(peerSignerAddress, {
      onMessage: (message) => {
        // Dedupe: same chunk can arrive multiple times (Bee re-serves cached
        // chunks, or broadcast+direct both deliver the same message).
        if (this.seenMessageIds.has(message.id)) return;
        this.markSeen(message.id);
        session.lastActivity = new Date().toISOString();
        this.emit({ type: "message-received", data: message });
      },
      onError: (error) => {
        this.emit({ type: "session-error", data: { peerAddress: peerSignerAddress, error: error.message } });
      },
    });

    // Mine GSOC signer for sending notifications to this peer (10-30s)
    if (!options?.skipGsoc) {
      try {
        const signerHex = this.gsoc.mineSigner(profile.overlayAddress);
        session.gsocSignerForPeer = signerHex;
      } catch (err) {
        console.warn(
          `[Chat] GSOC mining failed for ${peerSignerAddress.slice(0, 10)}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    session.ready = true;
    this.sessions.set(peerSignerAddress, session);

    this.emit({ type: "session-ready", data: { peerAddress: peerSignerAddress } });
    return session;
  }

  /**
   * Get an existing session by peer address.
   */
  getSession(peerAddress: string): ChatSession | undefined {
    return this.sessions.get(peerAddress);
  }

  /**
   * List all active sessions.
   */
  listSessions(): ChatSession[] {
    return [...this.sessions.values()];
  }

  // ─── Messaging ───────────────────────────────────────────────

  /**
   * Send a text message to a peer.
   *
   * Sends via PSS (encrypted, 2-10s latency) and optionally
   * sends a GSOC delivery notification (< 1s).
   */
  async sendMessage(
    session: ChatSession,
    text: string,
    attachment?: ChatAttachment,
  ): Promise<ChatMessage> {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      from: this.myAddress,
      to: session.peerAddress,
      text,
      attachment,
      timestamp: new Date().toISOString(),
      status: "sending",
    };

    // Send via PSS (direct topic between the two users)
    await this.pss.send(
      session.peerOverlay,
      session.peerBeeNodePubKey,
      session.peerAddress,
      message,
    );

    // Also send a broadcast ping so the recipient discovers this conversation
    // even if they haven't opened a chat with us yet. The broadcast topic
    // is per-recipient: ph:v2:chat:broadcast:<recipientAddress>
    this.pss.sendBroadcastPing(
      session.peerOverlay,
      session.peerBeeNodePubKey,
      session.peerAddress,
      message,
    ).catch(() => {}); // best-effort, don't block on this

    message.status = "sent";
    session.lastActivity = message.timestamp;
    this.emit({ type: "message-sent", data: message });

    // Send GSOC delivery notification (non-blocking, best-effort)
    if (session.gsocSignerForPeer) {
      this.gsoc.send(session.peerOverlay, "message-delivered", {
        messageId: message.id,
      }).catch(() => {});
    }

    return message;
  }

  /**
   * Share documents with a peer inline in the chat.
   *
   * Creates an ACT-protected share bundle and sends it as a
   * chat message with an attachment.
   */
  async shareDocumentInChat(
    session: ChatSession,
    text: string,
    docIds: string[],
    driveId: string,
    driveName: string,
  ): Promise<ChatMessage> {
    // Use the existing ACT sharing infrastructure
    const bundle = await this.buildShareBundle(docIds);
    if (!bundle) {
      throw new Error("No documents to share — all docs empty or missing.");
    }

    const shareResult = await this.client.uploadSharedData(
      JSON.stringify(bundle.data),
      session.peerBeeNodePubKey,
    );

    const attachment: ChatAttachment = {
      kind: "document-share",
      driveId,
      driveName,
      shareReference: shareResult.reference,
      actHistoryAddress: shareResult.actHistoryAddress,
      publisherBeeNodePubKey: await this.client.getBeeNodePublicKey(),
      documents: bundle.docs.map(d => ({
        id: d.documentId,
        name: d.name,
        type: d.documentType,
      })),
    };

    return this.sendMessage(session, text, attachment);
  }

  /**
   * Share a raw file (image, audio, video, PDF, etc.) inline in chat.
   *
   * The file is uploaded to Swarm with ACT protection. For images,
   * a thumbnail is generated for inline chat preview.
   *
   * For Powerhouse document models, use shareDocumentInChat() instead.
   */
  async shareFileInChat(
    session: ChatSession,
    text: string,
    fileData: Uint8Array | ArrayBuffer,
    fileName: string,
    mimeType: string,
  ): Promise<ChatMessage> {
    const result = await this.file.upload(
      fileData,
      fileName,
      mimeType,
      session.peerBeeNodePubKey,
    );

    return this.sendMessage(session, text, result.attachment);
  }

  /**
   * Download a file attachment from Swarm (ACT-decrypted by Bee) and
   * return it as a Blob ready for browser rendering.
   *
   * Prefers the thumbnail reference when `thumbnail: true` is passed and a
   * thumbnail exists — callers (chat bubbles, Files tab) should pass `true`
   * for grid/preview views to keep downloads small.
   */
  async downloadAttachment(
    attachment: import("./types.js").FileAttachment,
    opts?: { thumbnail?: boolean },
  ): Promise<Blob> {
    const wantThumb = opts?.thumbnail === true;
    const data =
      wantThumb && attachment.thumbnailReference
        ? await this.file.downloadThumbnail(attachment)
        : await this.file.download(attachment);
    if (!data) {
      throw new Error("Attachment data unavailable");
    }
    // If we asked for the thumbnail and it came back, the bytes are JPEG.
    const mime =
      wantThumb && attachment.thumbnailReference
        ? "image/jpeg"
        : attachment.mimeType;
    return new Blob([data as BlobPart], { type: mime });
  }

  /**
   * Probe a Swarm reference via HEAD /bzz/<ref>/ to discover its MIME type
   * and size. Used to render previews for external (non-ACT) hashes pasted
   * into chat messages as bzz:// or /bzz/ URLs.
   *
   * Results are cached per-reference since the metadata is immutable.
   */
  async probeSwarmReference(reference: string): Promise<{
    mimeType: string;
    sizeBytes: number;
    fileName?: string;
  }> {
    const cached = this.probeCache.get(reference);
    if (cached) return cached;

    const beeUrl = (this.client as any).bee?.url as string | undefined;
    if (!beeUrl) throw new Error("Bee URL unavailable");

    const res = await fetch(`${beeUrl}/bzz/${reference}/`, { method: "HEAD" });
    if (!res.ok) {
      throw new Error(`Probe failed for ${reference.slice(0, 10)}…: ${res.status}`);
    }

    const mimeType = (res.headers.get("content-type") ?? "application/octet-stream")
      .split(";")[0]
      .trim();
    const sizeBytes = Number(res.headers.get("content-length") ?? 0);

    // Content-Disposition: attachment; filename="foo.mp4"
    const disp = res.headers.get("content-disposition") ?? "";
    const match = disp.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    const fileName = match?.[1];

    const result = { mimeType, sizeBytes, fileName };
    this.probeCache.set(reference, result);
    return result;
  }

  // ─── Notifications ───────────────────────────────────────────

  /**
   * Send a typing indicator to a peer.
   */
  async sendTyping(session: ChatSession): Promise<void> {
    if (!session.gsocSignerForPeer) return;
    await this.gsoc.sendTyping(session.peerOverlay);
  }

  /**
   * Send a stopped-typing indicator.
   */
  async sendStoppedTyping(session: ChatSession): Promise<void> {
    if (!session.gsocSignerForPeer) return;
    await this.gsoc.sendStoppedTyping(session.peerOverlay);
  }

  /**
   * Announce online presence to a peer.
   */
  async sendOnline(session: ChatSession): Promise<void> {
    if (!session.gsocSignerForPeer) return;
    await this.gsoc.sendOnline(session.peerOverlay);
  }

  // ─── History (feed-indexed pagination) ───────────────────────

  /** Per-peer pending new messages to write as a batch */
  private pendingBatches = new Map<string, ChatMessage[]>();
  /** Per-peer debounce timers for flushing batches */
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Queue a new message to be written to the feed as part of the next batch.
   * Debounces 3s: all messages queued within the window are written as a
   * single feed entry (page), saving feed writes during rapid typing.
   */
  queueMessageForHistory(
    session: ChatSession,
    message: ChatMessage,
    debounceMs = 3000,
  ): void {
    const peer = session.peerAddress;
    const pending = this.pendingBatches.get(peer) ?? [];
    pending.push(message);
    this.pendingBatches.set(peer, pending);

    // Reset debounce timer
    const existing = this.persistTimers.get(peer);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.persistTimers.delete(peer);
      this.flushBatch(session).catch((err) => {
        console.warn("[Chat] Batch flush failed:", err instanceof Error ? err.message : err);
      });
    }, debounceMs);

    this.persistTimers.set(peer, timer);
  }

  /** Flush the pending batch as a new feed page. */
  private async flushBatch(session: ChatSession): Promise<void> {
    const peer = session.peerAddress;
    const batch = this.pendingBatches.get(peer);
    if (!batch || batch.length === 0) return;
    this.pendingBatches.delete(peer);

    await this.history.writePage(peer, batch, session.peerBeeNodePubKey);
    console.log(`[Chat] Wrote page (${batch.length} msg) to feed for ${peer.slice(0, 10)}`);
  }

  /**
   * Force-flush any pending batch for a peer.
   * Call when closing chat, switching conversations, or before unload.
   */
  async flushPendingHistory(session: ChatSession): Promise<void> {
    const timer = this.persistTimers.get(session.peerAddress);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(session.peerAddress);
    }
    await this.flushBatch(session);
  }

  /**
   * Load the latest N pages of history from BOTH peers' feeds.
   * Merges, dedupes by message ID, sorts chronologically.
   * Returns a cursor for loading older pages.
   *
   * @param pageCount - How many pages to load per feed (default 3)
   */
  async loadHistoryLatest(
    session: ChatSession,
    pageCount = 3,
  ): Promise<import("./chat-history.js").LoadedHistory> {
    const myBeeNodePubKey = await this.client.getBeeNodePublicKey();
    const result = await this.history.loadConversationLatest(
      session.peerAddress,
      myBeeNodePubKey,
      session.peerBeeNodePubKey,
      pageCount,
    );
    this.emit({
      type: "history-loaded",
      data: { peerAddress: session.peerAddress, count: result.messages.length },
    });
    return result;
  }

  /**
   * Load older pages using a cursor from a previous load.
   */
  async loadHistoryOlder(
    session: ChatSession,
    cursor: import("./chat-history.js").HistoryCursor,
    pageCount = 3,
  ): Promise<import("./chat-history.js").LoadedHistory> {
    const myBeeNodePubKey = await this.client.getBeeNodePublicKey();
    return this.history.loadConversationOlder(
      session.peerAddress,
      myBeeNodePubKey,
      session.peerBeeNodePubKey,
      cursor,
      pageCount,
    );
  }

  /** @deprecated Use loadHistoryLatest instead */
  async loadHistory(session: ChatSession): Promise<ChatMessage[]> {
    const result = await this.loadHistoryLatest(session, 3);
    return result.messages;
  }

  // ─── Events ──────────────────────────────────────────────────

  /**
   * Register a handler for chat events.
   */
  onEvent(handler: ChatEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Convenience: listen for incoming messages from any peer.
   */
  onMessage(handler: (message: ChatMessage) => void): () => void {
    return this.onEvent((event) => {
      if (event.type === "message-received") {
        handler(event.data as ChatMessage);
      }
    });
  }

  /**
   * Convenience: listen for GSOC notifications from any peer.
   */
  onNotification(handler: (notification: GsocNotification) => void): () => void {
    return this.onEvent((event) => {
      if (event.type === "notification-received") {
        handler(event.data as GsocNotification);
      }
    });
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  /**
   * Shut down all subscriptions and clean up.
   */
  shutdown(): void {
    this.pss.shutdown();
    this.gsoc.shutdown();
    this.sessions.clear();
    this.eventHandlers.clear();
  }

  // ─── Private ─────────────────────────────────────────────────

  private emit(event: ChatEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Don't let one handler crash others
      }
    }
  }

  private markSeen(id: string): void {
    this.seenMessageIds.add(id);
    // Trim in a batch when the set grows past the cap. One-at-a-time deletion
    // can't keep up under bursts (Bee sometimes re-delivers cached chunks
    // many times in the same tick).
    if (this.seenMessageIds.size > 500) {
      const ids = [...this.seenMessageIds];
      this.seenMessageIds.clear();
      for (let i = ids.length - 400; i < ids.length; i++) {
        this.seenMessageIds.add(ids[i]);
      }
    }
  }

  private async buildShareBundle(docIds: string[]): Promise<{
    data: { documents: Array<{ documentId: string; documentType: string; name: string; operations: unknown[] }> };
    docs: Array<{ documentId: string; documentType: string; name: string }>;
  } | null> {
    const documents: Array<{ documentId: string; documentType: string; name: string; operations: unknown[] }> = [];

    for (const docId of docIds) {
      try {
        const manifest = await this.client.readManifest(docId);
        if (!manifest || manifest.operationBatches.length === 0) continue;

        const allOps: unknown[] = [];
        for (const batch of manifest.operationBatches) {
          const data = await this.client.downloadData(batch.reference);
          const ops = JSON.parse(new TextDecoder().decode(data));
          allOps.push(...(Array.isArray(ops) ? ops : [ops]));
        }

        documents.push({
          documentId: docId,
          documentType: manifest.documentType,
          name: docId, // Caller can override with display name
          operations: allOps,
        });
      } catch {
        // Skip docs that can't be read
      }
    }

    if (documents.length === 0) return null;
    return {
      data: { documents },
      docs: documents.map(d => ({ documentId: d.documentId, documentType: d.documentType, name: d.name })),
    };
  }
}
