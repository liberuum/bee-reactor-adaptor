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
  ChatEvent,
  ChatEventHandler,
  GsocNotification,
} from "./types.js";
import { PssMessenger, chatTopic } from "./pss-messenger.js";
import { ChatHistory, historyTopic } from "./chat-history.js";
import { GsocNotifier } from "./gsoc-notifier.js";

export class ChatManager {
  private readonly pss: PssMessenger;
  private readonly history: ChatHistory;
  private readonly gsoc: GsocNotifier;
  private readonly sessions = new Map<string, ChatSession>();
  private readonly eventHandlers = new Set<ChatEventHandler>();
  private readonly myAddress: string;

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
        `Peer ${peerSignerAddress.slice(0, 10)} has no public profile on Swarm. ` +
        `They need to connect to Swarm at least once.`,
      );
    }
    if (!profile.beeNodePublicKey || !profile.overlayAddress) {
      throw new Error(
        `Peer ${peerSignerAddress.slice(0, 10)}'s profile is missing beeNodePublicKey or overlayAddress.`,
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

    // Send via PSS
    await this.pss.send(
      session.peerOverlay,
      session.peerBeeNodePubKey,
      session.peerAddress,
      message,
    );

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

  // ─── History ─────────────────────────────────────────────────

  /**
   * Persist messages to the chat history feed (ACT-encrypted).
   */
  async persistMessages(
    session: ChatSession,
    messages: ChatMessage[],
  ): Promise<void> {
    const result = await this.history.writeMessages(
      session.peerAddress,
      messages,
      session.peerBeeNodePubKey,
    );
    session.actGranteeRef = result.actGranteeRef;
    session.actHistoryRef = result.actHistoryRef;
  }

  /**
   * Load chat history from the peer's feed.
   */
  async loadHistory(session: ChatSession): Promise<ChatMessage[]> {
    if (!session.actHistoryRef) return [];

    const page = await this.history.readMessages(
      session.peerAddress,
      session.peerBeeNodePubKey,
      session.actHistoryRef,
    );

    if (page) {
      this.emit({ type: "history-loaded", data: { peerAddress: session.peerAddress, count: page.messages.length } });
      return page.messages;
    }
    return [];
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
