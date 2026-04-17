import { reconcileMime } from "./mime-guess.js";
import { PssMessenger, chatTopic } from "./pss-messenger.js";
import { ChatHistory, historyTopic, getMyChatChapter, recordPeerChatChapter, } from "./chat-history.js";
import { GsocNotifier } from "./gsoc-notifier.js";
import { SwarmFile } from "./swarm-file.js";
import { ensureChatPeerInUserManifest, readUserManifestCached, } from "../channel/manifest-manager.js";
export class ChatManager {
    client;
    pss;
    history;
    gsoc;
    file;
    sessions = new Map();
    eventHandlers = new Set();
    myAddress;
    /** Set of message IDs we've already emitted, to prevent duplicates when
     *  the same chunk arrives via multiple channels (broadcast + direct PSS,
     *  or Bee node re-serving cached chunks). Trimmed periodically. */
    seenMessageIds = new Set();
    /** Metadata cache for external Swarm references probed via HEAD /bzz/.
     *  Keyed by hex reference. Content is immutable so cache is never invalidated. */
    probeCache = new Map();
    constructor(client, bee, batchId, myAddress) {
        this.client = client;
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
                // Ignore our own broadcast pings. The broadcast topic is shared by
                // everyone, so our outgoing "here's a new conversation from me"
                // ping can echo back through our own Bee node. Without this guard
                // the echo would create a session with ourselves as peer and the
                // conversation list would show our own Swarm ID as an entry.
                if (message.from.toLowerCase() === this.myAddress.toLowerCase())
                    return;
                // Suppress cached broadcast pings older than the last "clear
                // chats" action. After clearing, the Bee node often replays
                // buffered PSS chunks to the freshly-subscribed socket — those
                // replays would call startSession → ensureChatPeerInUserManifest
                // and immediately re-populate the manifest we just cleared.
                // The clear timestamp is stored in localStorage by the UI-side
                // clearChats action so it persists across page reloads.
                try {
                    const raw = globalThis.window?.localStorage?.getItem?.("swarm:chatsClearedAt");
                    const clearedAt = raw ? parseInt(raw, 10) : 0;
                    if (clearedAt > 0 && message.timestamp) {
                        const ts = new Date(message.timestamp).getTime();
                        if (ts > 0 && ts < clearedAt)
                            return;
                    }
                }
                catch { /* localStorage unavailable */ }
                // Deduplicate SYNCHRONOUSLY. Bee may re-serve the same cached chunk
                // multiple times in rapid succession; if we wait until after the
                // async startSession to mark it seen, parallel deliveries all race
                // past the check.
                if (this.seenMessageIds.has(message.id))
                    return;
                this.markSeen(message.id);
                // Record peer's chapter so my next read of their feed uses the
                // rotated topic if they've cleared their chat since we last spoke.
                if (typeof message.chapter === "number" && message.chapter > 0) {
                    recordPeerChatChapter(message.from, message.chapter);
                }
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
    async startSession(peerSignerAddress, options) {
        const existing = this.sessions.get(peerSignerAddress);
        if (existing?.ready)
            return existing;
        // Resolve peer's public profile
        const profile = await this.client.readPublicProfile(peerSignerAddress);
        if (!profile) {
            throw new Error(`No Swarm profile found for ${peerSignerAddress.slice(0, 10)}…${peerSignerAddress.slice(-4)}. ` +
                `Make sure you're using their Swarm ID (not wallet address). ` +
                `They can find their Swarm ID in Swarm Settings → Your Swarm ID.`);
        }
        if (!profile.beeNodePublicKey || !profile.overlayAddress) {
            throw new Error(`Peer's profile is incomplete (missing Bee node public key or overlay). ` +
                `Ask them to reconnect their Swarm node.`);
        }
        const session = {
            peerAddress: peerSignerAddress,
            peerOverlay: profile.overlayAddress,
            peerBeeNodePubKey: profile.beeNodePublicKey,
            // Leaving peerDisplayName unset — the UI falls back to the Swarm
            // signer address (peerAddress) which is what users actually copy
            // from "Your Swarm ID" and paste into "New conversation". Using
            // profile.ethAddress here caused the list card to show the peer's
            // wallet while the thread header showed the signer — two different
            // 0x… addresses for the same person, confusing on sight. If we
            // want a friendlier label (ENS resolve, pet name) later, set it
            // here to that resolved value — never the raw ethAddress.
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
                if (this.seenMessageIds.has(message.id))
                    return;
                this.markSeen(message.id);
                // Track peer's current history-chapter so reads migrate to the
                // new feed when they've cleared their chat.
                if (typeof message.chapter === "number" && message.chapter > 0) {
                    recordPeerChatChapter(message.from, message.chapter);
                }
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
            }
            catch (err) {
                console.warn(`[Chat] GSOC mining failed for ${peerSignerAddress.slice(0, 10)}:`, err instanceof Error ? err.message : err);
            }
        }
        session.ready = true;
        this.sessions.set(peerSignerAddress, session);
        // Record the peer in the user manifest so a fresh browser can
        // reconstruct the conversation list on recovery. Fire-and-forget —
        // failure to record shouldn't block the session from becoming ready.
        ensureChatPeerInUserManifest(this.client, this.myAddress, peerSignerAddress)
            .catch((err) => {
            console.warn(`[Chat] Failed to record peer in user manifest:`, err instanceof Error ? err.message : err);
        });
        this.emit({ type: "session-ready", data: { peerAddress: peerSignerAddress } });
        return session;
    }
    /**
     * Get an existing session by peer address.
     */
    getSession(peerAddress) {
        return this.sessions.get(peerAddress);
    }
    /**
     * Read the list of chat peers previously recorded in the user manifest.
     * Used by Connect to reconstruct the conversation list on a fresh
     * browser — without this, recovery would only discover conversations
     * after the peer sends another message.
     */
    async listKnownChatPeers() {
        try {
            // Use the cached read so a manifest-write that just happened
            // (e.g. clearChatPeersInUserManifest) is reflected immediately,
            // without waiting for the Swarm feed to converge. Going straight
            // to the feed here caused "clear chats" to see stale peers.
            const manifest = await readUserManifestCached(this.client, this.myAddress);
            const peers = manifest?.chatPeers ?? [];
            const myAddr = this.myAddress.toLowerCase();
            // Filter out our own address if a prior bug (pre-broadcast-echo-guard)
            // recorded it as a peer. Keeps the conversation list clean without
            // requiring users to manually purge their manifest.
            return peers
                .map((p) => p.toLowerCase())
                .filter((p) => p !== myAddr);
        }
        catch (err) {
            console.warn("[Chat] Could not read known chat peers:", err instanceof Error ? err.message : err);
            return [];
        }
    }
    /**
     * List all active sessions.
     */
    listSessions() {
        return [...this.sessions.values()];
    }
    // ─── Messaging ───────────────────────────────────────────────
    /**
     * Send a text message to a peer.
     *
     * Sends via PSS (encrypted, 2-10s latency) and optionally
     * sends a GSOC delivery notification (< 1s).
     */
    async sendMessage(session, text, attachment) {
        // Stamp outgoing messages with my current chapter so the peer can
        // learn that I've rotated to a new history feed (via Clear-All-Chats)
        // and follow me to it on their next read.
        const myChapter = getMyChatChapter();
        const message = {
            id: crypto.randomUUID(),
            from: this.myAddress,
            to: session.peerAddress,
            text,
            attachment,
            timestamp: new Date().toISOString(),
            status: "sending",
            ...(myChapter > 0 ? { chapter: myChapter } : {}),
        };
        // Send via PSS (direct topic between the two users)
        await this.pss.send(session.peerOverlay, session.peerBeeNodePubKey, session.peerAddress, message);
        // Also send a broadcast ping so the recipient discovers this conversation
        // even if they haven't opened a chat with us yet. The broadcast topic
        // is per-recipient: ph:v2:chat:broadcast:<recipientAddress>
        this.pss.sendBroadcastPing(session.peerOverlay, session.peerBeeNodePubKey, session.peerAddress, message).catch(() => { }); // best-effort, don't block on this
        message.status = "sent";
        session.lastActivity = message.timestamp;
        this.emit({ type: "message-sent", data: message });
        // Send GSOC delivery notification (non-blocking, best-effort)
        if (session.gsocSignerForPeer) {
            this.gsoc.send(session.peerOverlay, "message-delivered", {
                messageId: message.id,
            }).catch(() => { });
        }
        return message;
    }
    /**
     * Share documents with a peer inline in the chat.
     *
     * Creates an ACT-protected share bundle and sends it as a
     * chat message with an attachment.
     */
    async shareDocumentInChat(session, text, docIds, driveId, driveName) {
        // Use the same bundle builder as the settings-share path so the
        // recipient gets proper doc names (not UUIDs), full operation
        // history, folder structure, and preferredEditor — instead of a
        // minimal documents-array that produced empty docs on import.
        const { buildDriveShareBundle } = await import("../plugin/sharing.js");
        const built = await buildDriveShareBundle(this.client, driveId, docIds);
        if (!built) {
            throw new Error("No documents to share — all docs empty or missing.");
        }
        const shareResult = await this.client.uploadSharedData(JSON.stringify(built.bundle), session.peerBeeNodePubKey);
        const attachment = {
            kind: "document-share",
            driveId,
            // Prefer the bundle-resolved drive name over whatever the caller
            // passed — matches what the settings flow shows and keeps the
            // attachment card consistent with the actual drive.
            driveName: built.driveName || driveName,
            shareReference: shareResult.reference,
            actHistoryAddress: shareResult.actHistoryAddress,
            publisherBeeNodePubKey: await this.client.getBeeNodePublicKey(),
            documents: built.docs.map((d) => ({
                id: d.documentId,
                name: d.name,
                type: d.documentType,
            })),
        };
        return this.sendMessage(session, text, attachment);
    }
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
    async importDocumentShare(attachment) {
        const { applyDocumentBundle } = await import("../plugin/sharing.js");
        // Swarm chunks can take a few seconds to propagate after upload; retry
        // a few times before giving up (matches legacy import flow timing).
        const retryDelays = [0, 2000, 5000];
        let bundleData = null;
        let lastErr;
        for (const delay of retryDelays) {
            if (delay)
                await new Promise((r) => setTimeout(r, delay));
            try {
                bundleData = await this.client.downloadSharedData(attachment.shareReference, attachment.publisherBeeNodePubKey, attachment.actHistoryAddress);
                break;
            }
            catch (err) {
                lastErr = err;
            }
        }
        if (!bundleData) {
            return {
                success: false,
                imported: [],
                error: `Download failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
            };
        }
        return applyDocumentBundle(bundleData, {
            cacheKey: `swarm:importChatShare:${attachment.shareReference}`,
            displayName: `${attachment.driveName} (shared)`,
        });
    }
    /**
     * Share a raw file (image, audio, video, PDF, etc.) inline in chat.
     *
     * The file is uploaded to Swarm with ACT protection. For images,
     * a thumbnail is generated for inline chat preview.
     *
     * For Powerhouse document models, use shareDocumentInChat() instead.
     */
    async shareFileInChat(session, text, fileData, fileName, mimeType) {
        const result = await this.file.upload(fileData, fileName, mimeType, session.peerBeeNodePubKey);
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
    async downloadAttachment(attachment, opts) {
        const wantThumb = opts?.thumbnail === true;
        const data = wantThumb && attachment.thumbnailReference
            ? await this.file.downloadThumbnail(attachment)
            : await this.file.download(attachment);
        if (!data) {
            throw new Error("Attachment data unavailable");
        }
        // If we asked for the thumbnail and it came back, the bytes are JPEG.
        const mime = wantThumb && attachment.thumbnailReference
            ? "image/jpeg"
            : attachment.mimeType;
        return new Blob([data], { type: mime });
    }
    /**
     * Probe a Swarm reference via HEAD /bzz/<ref>/ to discover its MIME type
     * and size. Used to render previews for external (non-ACT) hashes pasted
     * into chat messages as bzz:// or /bzz/ URLs.
     *
     * Results are cached per-reference since the metadata is immutable.
     */
    async probeSwarmReference(reference) {
        const cached = this.probeCache.get(reference);
        if (cached)
            return cached;
        const beeUrl = this.client.bee?.url;
        if (!beeUrl)
            throw new Error("Bee URL unavailable");
        const res = await fetch(`${beeUrl}/bzz/${reference}/`, { method: "HEAD" });
        if (!res.ok) {
            throw new Error(`Probe failed for ${reference.slice(0, 10)}…: ${res.status}`);
        }
        const reportedMime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
        const sizeBytes = Number(res.headers.get("content-length") ?? 0);
        // Content-Disposition: attachment; filename="foo.mp4"
        const disp = res.headers.get("content-disposition") ?? "";
        const match = disp.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
        const fileName = match?.[1];
        // Bee's /bzz/ often returns application/x-www-form-urlencoded or
        // application/octet-stream for manifests where it can't identify the
        // real content type. Prefer a filename-derived guess in that case so
        // .mkv etc. still route to the video player.
        const mimeType = reconcileMime(reportedMime, fileName);
        const result = { mimeType, sizeBytes, fileName };
        this.probeCache.set(reference, result);
        return result;
    }
    // ─── Notifications ───────────────────────────────────────────
    /**
     * Send a typing indicator to a peer.
     */
    async sendTyping(session) {
        if (!session.gsocSignerForPeer)
            return;
        await this.gsoc.sendTyping(session.peerOverlay);
    }
    /**
     * Send a stopped-typing indicator.
     */
    async sendStoppedTyping(session) {
        if (!session.gsocSignerForPeer)
            return;
        await this.gsoc.sendStoppedTyping(session.peerOverlay);
    }
    /**
     * Announce online presence to a peer.
     */
    async sendOnline(session) {
        if (!session.gsocSignerForPeer)
            return;
        await this.gsoc.sendOnline(session.peerOverlay);
    }
    // ─── History (feed-indexed pagination) ───────────────────────
    /** Per-peer pending new messages to write as a batch */
    pendingBatches = new Map();
    /** Per-peer debounce timers for flushing batches */
    persistTimers = new Map();
    /**
     * Queue a new message to be written to the feed as part of the next batch.
     * Debounces 3s: all messages queued within the window are written as a
     * single feed entry (page), saving feed writes during rapid typing.
     */
    queueMessageForHistory(session, message, debounceMs = 3000) {
        const peer = session.peerAddress;
        const pending = this.pendingBatches.get(peer) ?? [];
        pending.push(message);
        this.pendingBatches.set(peer, pending);
        // Reset debounce timer
        const existing = this.persistTimers.get(peer);
        if (existing)
            clearTimeout(existing);
        const timer = setTimeout(() => {
            this.persistTimers.delete(peer);
            this.flushBatch(session).catch((err) => {
                console.warn("[Chat] Batch flush failed:", err instanceof Error ? err.message : err);
            });
        }, debounceMs);
        this.persistTimers.set(peer, timer);
    }
    /** Flush the pending batch as a new feed page. */
    async flushBatch(session) {
        const peer = session.peerAddress;
        const batch = this.pendingBatches.get(peer);
        if (!batch || batch.length === 0)
            return;
        this.pendingBatches.delete(peer);
        await this.history.writePage(peer, batch, session.peerBeeNodePubKey);
        console.log(`[Chat] Wrote page (${batch.length} msg) to feed for ${peer.slice(0, 10)}`);
    }
    /**
     * Force-flush any pending batch for a peer.
     * Call when closing chat, switching conversations, or before unload.
     */
    async flushPendingHistory(session) {
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
    async loadHistoryLatest(session, pageCount = 3) {
        const myBeeNodePubKey = await this.client.getBeeNodePublicKey();
        const result = await this.history.loadConversationLatest(session.peerAddress, myBeeNodePubKey, session.peerBeeNodePubKey, pageCount);
        this.emit({
            type: "history-loaded",
            data: { peerAddress: session.peerAddress, count: result.messages.length },
        });
        return result;
    }
    /**
     * Load older pages using a cursor from a previous load.
     */
    async loadHistoryOlder(session, cursor, pageCount = 3) {
        const myBeeNodePubKey = await this.client.getBeeNodePublicKey();
        return this.history.loadConversationOlder(session.peerAddress, myBeeNodePubKey, session.peerBeeNodePubKey, cursor, pageCount);
    }
    /** @deprecated Use loadHistoryLatest instead */
    async loadHistory(session) {
        const result = await this.loadHistoryLatest(session, 3);
        return result.messages;
    }
    // ─── Events ──────────────────────────────────────────────────
    /**
     * Register a handler for chat events.
     */
    onEvent(handler) {
        this.eventHandlers.add(handler);
        return () => this.eventHandlers.delete(handler);
    }
    /**
     * Convenience: listen for incoming messages from any peer.
     */
    onMessage(handler) {
        return this.onEvent((event) => {
            if (event.type === "message-received") {
                handler(event.data);
            }
        });
    }
    /**
     * Convenience: listen for GSOC notifications from any peer.
     */
    onNotification(handler) {
        return this.onEvent((event) => {
            if (event.type === "notification-received") {
                handler(event.data);
            }
        });
    }
    // ─── Lifecycle ───────────────────────────────────────────────
    /**
     * Shut down all subscriptions and clean up.
     */
    shutdown() {
        this.pss.shutdown();
        this.gsoc.shutdown();
        this.sessions.clear();
        this.eventHandlers.clear();
    }
    // ─── Private ─────────────────────────────────────────────────
    emit(event) {
        for (const handler of this.eventHandlers) {
            try {
                handler(event);
            }
            catch {
                // Don't let one handler crash others
            }
        }
    }
    markSeen(id) {
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
}
//# sourceMappingURL=chat-manager.js.map