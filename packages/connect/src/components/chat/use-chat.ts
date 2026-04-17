/**
 * React hook for managing chat state.
 * Bridges the adapter's ChatManager with React component state.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import type { ChatMessage, ChatSession, ConversationSummary, ChatView } from "./types.js";
import { reconcileMime } from "../../../../adapter/src/chat/mime-guess.js";

function getManager(): any | null {
  const ph = (globalThis as any).window?.ph;
  return ph?.swarm?.chat?.manager ?? null;
}

function getMyAddress(): string {
  // Swarm SIGNER address (used for routing chat messages + history feeds),
  // NOT the Ethereum wallet address. signerEntry.ownerAddress is actually
  // the ETH wallet address; the real Swarm address comes from the Bee
  // client's signer.
  const ph = (globalThis as any).window?.ph;
  return ph?.swarm?.client?.getOwnerAddress?.()
    ?? ph?.swarm?.signerEntry?.swarmAddress
    ?? "";
}

const CHAT_STORAGE_KEY = "swarm:chatMessages";
const CHAT_LAST_READ_KEY = "swarm:chatLastRead";

function loadStoredMessages(): Map<string, ChatMessage[]> {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return new Map();
    const entries = JSON.parse(raw) as Array<[string, ChatMessage[]]>;
    return new Map(entries);
  } catch { return new Map(); }
}

function saveMessages(map: Map<string, ChatMessage[]>): void {
  try {
    // Keep last 100 messages per conversation
    const trimmed = new Map<string, ChatMessage[]>();
    for (const [peer, msgs] of map) {
      trimmed.set(peer, msgs.slice(-100));
    }
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify([...trimmed]));
    window.dispatchEvent(new CustomEvent("swarm:chatMessages:updated"));
  } catch { /* localStorage full or unavailable */ }
}

/** Per-peer "last read at" timestamp (ms epoch). Messages with a
 *  later timestamp are considered unread. */
function loadLastRead(): Map<string, number> {
  try {
    const raw = localStorage.getItem(CHAT_LAST_READ_KEY);
    if (!raw) return new Map();
    return new Map(JSON.parse(raw) as Array<[string, number]>);
  } catch { return new Map(); }
}

function saveLastRead(map: Map<string, number>): void {
  try {
    localStorage.setItem(CHAT_LAST_READ_KEY, JSON.stringify([...map]));
    window.dispatchEvent(new CustomEvent("swarm:chatLastRead:updated"));
  } catch { /* */ }
}

export function useChat() {
  const [view, setView] = useState<ChatView>("conversations");
  const [activePeer, setActivePeer] = useState<string | null>(null);
  // Use a counter to force re-renders when messages change
  const [, setRenderTick] = useState(0);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  // Three-state readiness so the UI distinguishes "Bee not set up yet"
  // from "Bee is up, ChatManager just hasn't mounted in the poll window".
  //   waiting    → no SwarmClient (show full requirements checklist)
  //   connecting → SwarmClient exists, ChatManager not yet populated
  //                (brief spinner, NOT the scary checklist)
  //   ready      → ChatManager available, chat UI fully live
  const [readiness, setReadiness] = useState<"waiting" | "connecting" | "ready">(() => {
    const ph = (globalThis as any).window?.ph;
    if (ph?.swarm?.chat?.manager) return "ready";
    if (ph?.swarm?.client) return "connecting";
    return "waiting";
  });
  const isReady = readiness === "ready";
  const [isSending, setIsSending] = useState(false);
  const [isHydrating, setIsHydrating] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True from the moment a conversation is clicked until startSession resolves.
  // UI should show a "Connecting…" placeholder, not the empty state.
  const [isOpeningConversation, setIsOpeningConversation] = useState(false);
  // Set while a file upload is in flight — the composer shows an
  // "Uploading {name}…" pill. Uploads take multiple seconds (grantee
  // creation + ACT wait + bzz upload + thumbnail), so users need a
  // signal distinct from the plain send spinner.
  const [uploadingFile, setUploadingFile] = useState<{ name: string; sizeBytes: number } | null>(null);

  // Cursor state per peer for pagination
  const cursorsRef = useRef<Map<string, any>>(new Map());

  // Monotonically increasing counter to detect stale in-flight hydrations
  // after the user switches conversations
  const hydrationEpochRef = useRef(0);

  // Store messages in a ref (loaded from localStorage on init)
  const messagesRef = useRef<Map<string, ChatMessage[]>>(loadStoredMessages());
  const lastReadRef = useRef<Map<string, number>>(loadLastRead());
  const activePeerRef = useRef<string | null>(null);
  const subscribedRef = useRef(false);

  activePeerRef.current = activePeer;

  // Current conversation messages
  const messages = activePeer ? (messagesRef.current.get(activePeer) ?? []) : [];

  // Add a message, persist to localStorage, and trigger re-render
  const addMessage = useCallback((peerAddress: string, msg: ChatMessage) => {
    const map = messagesRef.current;
    const existing = map.get(peerAddress) ?? [];
    // Deduplicate by ID
    if (existing.some(m => m.id === msg.id)) return;
    map.set(peerAddress, [...existing, msg]);
    saveMessages(map);
    // Force re-render
    setRenderTick(t => t + 1);
  }, []);

  // Rebuild conversation list from ChatManager sessions + stored messages
  const refreshConversations = useCallback(() => {
    const myAddr = getMyAddress().toLowerCase();
    const manager = getManager();

    // Collect all peers from both sessions and stored messages.
    // Skip our own address — a prior bug could self-record us as a peer
    // via the broadcast-topic echo; defensive filter so stale localStorage
    // or manifest entries don't resurface an "I'm talking to myself" card.
    const allPeers = new Set<string>();
    const isSelf = (addr: string) => addr.toLowerCase() === myAddr;
    if (manager) {
      const sessions = manager.listSessions() as ChatSession[];
      sessions.forEach((s: ChatSession) => {
        if (!isSelf(s.peerAddress)) allPeers.add(s.peerAddress);
      });
    }
    for (const peer of messagesRef.current.keys()) {
      if (!isSelf(peer)) allPeers.add(peer);
    }

    const summaries: ConversationSummary[] = [...allPeers].map((peerAddr) => {
      const session = manager?.getSession?.(peerAddr) as ChatSession | undefined;
      const peerMsgs = messagesRef.current.get(peerAddr) ?? [];
      const lastMsg = peerMsgs[peerMsgs.length - 1];
      const lastRead = lastReadRef.current.get(peerAddr) ?? 0;

      // Determine if a message was SENT by me:
      // - Prefer checking msg.to === peerAddr (most reliable — doesn't depend on myAddr)
      // - Fallback: msg.from !== myAddr (only trustworthy if myAddr is loaded)
      const isFromPeer = (m: ChatMessage): boolean => {
        // If msg.to matches the peer we're talking with, we sent it
        if (m.to && m.to.toLowerCase() === peerAddr.toLowerCase()) return false;
        // Otherwise it came from the peer
        return true;
      };

      // Count unread: messages FROM the peer with timestamp > lastRead
      const unread = activePeerRef.current === peerAddr
        ? 0
        : peerMsgs.filter((m) => {
            if (!isFromPeer(m)) return false;
            const ts = new Date(m.timestamp).getTime();
            return ts > lastRead;
          }).length;

      return {
        peerAddress: peerAddr,
        peerDisplayName: session?.peerDisplayName,
        lastMessage: lastMsg?.text?.slice(0, 50),
        lastMessageTime: lastMsg?.timestamp ?? session?.lastActivity,
        unreadCount: unread,
        isOnline: session?.ready ?? false,
      };
    });
    // Sort by last message time (newest first)
    summaries.sort((a, b) => {
      const ta = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0;
      const tb = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0;
      return tb - ta;
    });
    setConversations(summaries);
  }, []);

  // Subscribe to ChatManager events (once per mount; unsubscribed on unmount
  // so reopening the chat panel doesn't stack duplicate handlers).
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;

    // Poll at 200ms until ChatManager is ready so the user doesn't stare
    // at an empty "connecting" state for up to 1.5s on a perfectly fine
    // setup. Once we've subscribed we drop to 1500ms for the routine
    // conversation-list refresh.
    let tickMs = 200;
    const tick = () => {
      const ph = (globalThis as any).window?.ph;
      const hasClient = !!ph?.swarm?.client;
      const manager = getManager();

      if (!manager) {
        // Pivot the readiness state based on whether the Bee layer is
        // up yet. No client → show the full requirements checklist.
        // Client but no ChatManager → brief "Connecting…" spinner.
        const next = hasClient ? "connecting" : "waiting";
        setReadiness((cur) => (cur === next ? cur : next));
        return;
      }

      if (readiness !== "ready") setReadiness("ready");

      if (!subscribedRef.current) {
        subscribedRef.current = true;

        unsubscribe = manager.onMessage((msg: ChatMessage) => {
          console.log(`[Chat UI] Received from ${msg.from.slice(0, 10)}: "${msg.text.slice(0, 30)}"`);
          addMessage(msg.from, msg);
          // If the user is currently viewing this conversation, mark as read
          if (activePeerRef.current === msg.from) {
            lastReadRef.current.set(msg.from, Date.now());
            saveLastRead(lastReadRef.current);
          }
          refreshConversations();
        });

        console.log("[Chat UI] Subscribed to ChatManager events");

        // Recover known chat peers from the user manifest on Swarm so a
        // fresh browser rebuilds the conversation list. Fire-and-forget —
        // each peer with no local record kicks off a lazy session start.
        void (async () => {
          try {
            // ── Seed Swarm's chatPeers list from any local conversations
            // we already know about (existing chats from before the manifest-
            // based recovery landed). Idempotent: startSession records the
            // peer in the manifest via ensureChatPeerInUserManifest, which
            // short-circuits if the entry already exists.
            const locallyKnown = [...messagesRef.current.keys()];
            if (locallyKnown.length > 0) {
              for (const peer of locallyKnown) {
                try {
                  if (!manager.getSession(peer)) {
                    await manager.startSession(peer, { skipGsoc: true });
                  }
                } catch { /* best effort — peer profile may be missing */ }
              }
            }

            const peers: string[] = await manager.listKnownChatPeers();
            if (peers.length === 0) {
              console.log(`[Chat UI] No chat peers recorded yet`);
              return;
            }
            const locallyKnownSet = new Set(messagesRef.current.keys());
            const toRecover = peers.filter((p) => !locallyKnownSet.has(p));
            if (toRecover.length === 0) {
              console.log(`[Chat UI] ${peers.length} known peers — all already local`);
              return;
            }
            console.log(`[Chat UI] Recovering ${toRecover.length} peer(s) from Swarm manifest`);
            for (const peerAddress of toRecover) {
              try {
                await manager.startSession(peerAddress, { skipGsoc: true });
                // Seed an empty bucket so the conversation shows in the list
                // even before history has been fetched — openConversation
                // will lazily pull history when clicked.
                if (!messagesRef.current.has(peerAddress)) {
                  messagesRef.current.set(peerAddress, []);
                }
              } catch (err) {
                console.warn(
                  `[Chat UI] Could not recover peer ${peerAddress.slice(0, 10)}:`,
                  err instanceof Error ? err.message : err,
                );
              }
            }
            refreshConversations();
          } catch (err) {
            console.warn(
              "[Chat UI] Chat peer recovery failed:",
              err instanceof Error ? err.message : err,
            );
          }
        })();
      }

      refreshConversations();
      // Once we're subscribed, back off to the normal refresh cadence.
      tickMs = 1500;
    };

    // Drive the tick with setTimeout so we can vary the interval
    // (200ms before ChatManager lands, 1500ms after).
    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      tick();
      timer = setTimeout(loop, tickMs);
    };
    loop();

    return () => {
      clearTimeout(timer);
      if (unsubscribe) {
        unsubscribe();
        subscribedRef.current = false;
      }
    };
    // `readiness` is intentionally NOT in the dep array — it would tear
    // down and recreate the subscription on every state transition,
    // doubling event handlers. The tick reads ph.swarm directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addMessage, refreshConversations]);

  // When clearChats runs (or any other code wipes swarm:chatMessages
  // directly), reload the in-memory mirror and re-render. Without this
  // listener the UI keeps showing deleted conversations because
  // messagesRef is only read from localStorage on mount.
  useEffect(() => {
    const handleWipe = () => {
      messagesRef.current = loadStoredMessages();
      lastReadRef.current = loadLastRead();
      cursorsRef.current = new Map();
      setActivePeer(null);
      setView("conversations");
      setRenderTick((t) => t + 1);
      refreshConversations();
    };
    window.addEventListener("swarm:chatsCleared", handleWipe);
    return () => window.removeEventListener("swarm:chatsCleared", handleWipe);
  }, [refreshConversations]);

  const markRead = useCallback((peerAddress: string) => {
    lastReadRef.current.set(peerAddress, Date.now());
    saveLastRead(lastReadRef.current);
  }, []);

  /** Merge remote messages into local store (dedupe by ID, sort chronologically) */
  const mergeMessages = useCallback((peerAddress: string, incoming: ChatMessage[]) => {
    if (incoming.length === 0) return;
    const map = messagesRef.current;
    const existing = map.get(peerAddress) ?? [];
    const byId = new Map<string, ChatMessage>();
    for (const m of [...existing, ...incoming]) {
      if (!byId.has(m.id)) byId.set(m.id, m);
    }
    const merged = [...byId.values()].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    map.set(peerAddress, merged);
    saveMessages(map);
    setRenderTick(t => t + 1);
    refreshConversations();
  }, [refreshConversations]);

  /** Load older pages from Swarm feeds for the active conversation */
  const loadOlderHistory = useCallback(async () => {
    const manager = getManager();
    const peer = activePeerRef.current;
    if (!manager || !peer) return;
    const cursor = cursorsRef.current.get(peer);
    if (!cursor) return;

    const session = manager.getSession(peer);
    if (!session) return;

    setIsLoadingOlder(true);
    try {
      const loaded = await manager.loadHistoryOlder(session, cursor, 3);
      cursorsRef.current.set(peer, loaded.cursor);
      setHasMoreHistory(loaded.hasMore);

      if (loaded.messages.length > 0) {
        mergeMessages(peer, loaded.messages);
        console.log(`[Chat] Loaded ${loaded.messages.length} older msg(s) (hasMore=${loaded.hasMore})`);
      }
    } catch (err) {
      console.warn("[Chat] Load older failed:", err);
    } finally {
      setIsLoadingOlder(false);
    }
  }, [mergeMessages]);

  const openConversation = useCallback(async (peerAddress: string) => {
    const manager = getManager();
    if (!manager) return;

    setError(null);

    // Optimistically switch the thread view so the user sees immediate
    // feedback ("Connecting to peer…") instead of the empty state while
    // startSession resolves the profile + PSS subscription.
    setActivePeer(peerAddress);
    setView("thread");
    setIsOpeningConversation(true);
    // Mark as read IMMEDIATELY on click — don't wait for startSession to
    // resolve (can be 1-3s on first open). Otherwise the sidebar unread
    // badge lingers while the user is already looking at the thread, and
    // if startSession throws the badge never clears at all.
    markRead(peerAddress);
    refreshConversations();

    try {
      const session = await manager.startSession(peerAddress, { skipGsoc: true });
      setIsOpeningConversation(false);

      // Hydrate latest page from Swarm feeds (both parties) — non-blocking.
      // Use an epoch counter so a stale hydration that resolves after the
      // user switched conversations doesn't clobber the spinner / pagination
      // state of the newly active thread.
      const epoch = ++hydrationEpochRef.current;
      // Capture BEFORE the async pull — if the bucket is empty now, this is
      // a fresh-browser recovery and we want to auto-paginate back to the
      // beginning of history. On re-opens we already have everything locally
      // and should respect the 3-page default to stay fast.
      const wasEmptyLocally =
        (messagesRef.current.get(peerAddress) ?? []).length === 0;
      setIsHydrating(true);
      setHasMoreHistory(false);
      (async () => {
        try {
          const loaded = await manager.loadHistoryLatest(session, 3);
          let cursor = loaded.cursor;
          let hasMore = loaded.hasMore;
          cursorsRef.current.set(peerAddress, cursor);

          if (loaded.messages.length === 0) {
            console.log(`[Chat] No history found on feeds for ${peerAddress.slice(0, 10)}`);
          } else {
            mergeMessages(peerAddress, loaded.messages);
            console.log(`[Chat] Hydrated ${loaded.messages.length} msg(s) from feeds (hasMore=${hasMore})`);
          }

          // Fresh-browser recovery: walk the rest of history automatically
          // so the user sees the full conversation on first open. Bounded
          // by MAX_AUTO_PAGES to cap worst-case cost on very long threads
          // (remaining older pages stay available via scroll-to-load-more).
          if (wasEmptyLocally && hasMore) {
            const MAX_AUTO_PAGES = 50;
            let pagesPulled = 0;
            while (hasMore && pagesPulled < MAX_AUTO_PAGES) {
              if (hydrationEpochRef.current !== epoch) return;
              const more = await manager.loadHistoryOlder(session, cursor, 5);
              pagesPulled++;
              cursor = more.cursor;
              hasMore = more.hasMore;
              cursorsRef.current.set(peerAddress, cursor);
              if (more.messages.length > 0) mergeMessages(peerAddress, more.messages);
            }
            if (pagesPulled > 0) {
              console.log(
                `[Chat] Auto-paginated ${pagesPulled} older batch(es) on fresh-browser recovery`,
              );
            }
          }

          if (hydrationEpochRef.current === epoch) setHasMoreHistory(hasMore);
        } catch (err) {
          console.warn("[Chat] History hydration failed:", err);
        } finally {
          if (hydrationEpochRef.current === epoch) setIsHydrating(false);
        }
      })();
    } catch (err) {
      console.warn("[Chat] Failed to start session:", err);
      setError(err instanceof Error ? err.message : String(err));
      // Revert the optimistic peer switch since the session never materialized
      setActivePeer(null);
      setView("conversations");
      setIsOpeningConversation(false);
    }
  }, [refreshConversations, markRead]);

  const dismissError = useCallback(() => setError(null), []);

  const sendMessage = useCallback(async (text: string) => {
    const manager = getManager();
    const peer = activePeerRef.current;
    if (!manager || !peer) return;

    setIsSending(true);
    try {
      const session = manager.getSession(peer);
      if (!session) throw new Error("No active session");

      const msg = await manager.sendMessage(session, text);
      addMessage(peer, msg);
      refreshConversations();

      // Queue for feed persistence (debounced batch write in background)
      manager.queueMessageForHistory(session, msg);
    } catch (err) {
      console.error("[Chat] Send failed:", err);
    } finally {
      setIsSending(false);
    }
  }, [addMessage, refreshConversations]);

  const sendFile = useCallback(async (file: File, text?: string) => {
    const manager = getManager();
    const peer = activePeerRef.current;
    if (!manager || !peer) return;

    // Client-side size guard — the adapter enforces the same cap too, but
    // failing in the browser first avoids a multi-second grantee + upload
    // round-trip for obviously-too-large files.
    const MAX_BYTES = 200 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      setError(
        `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — max 200 MB for chat file sharing.`,
      );
      return;
    }

    setIsSending(true);
    setUploadingFile({ name: file.name, sizeBytes: file.size });
    try {
      const session = manager.getSession(peer);
      if (!session) throw new Error("No active session");

      const data = new Uint8Array(await file.arrayBuffer());
      // Some browsers/OSes report an empty file.type for less-common
      // formats (e.g. .mkv). Fall back to our extension-based guess so
      // the recipient's UI routes to the right preview component.
      const resolvedMime = reconcileMime(file.type, file.name);
      const msg = await manager.shareFileInChat(
        session,
        text || file.name,
        data,
        file.name,
        resolvedMime,
      );
      addMessage(peer, msg);
      refreshConversations();

      // Queue for feed persistence (debounced batch write)
      manager.queueMessageForHistory(session, msg);
    } catch (err) {
      console.error("[Chat] File send failed:", err);
      setError(err instanceof Error ? err.message : "File upload failed");
    } finally {
      setIsSending(false);
      setUploadingFile(null);
    }
  }, [addMessage, refreshConversations]);

  const shareDocuments = useCallback(
    async (driveId: string, driveName: string, docIds: string[], text?: string) => {
      const manager = getManager();
      const peer = activePeerRef.current;
      if (!manager || !peer) return;
      if (docIds.length === 0) {
        setError("No documents selected to share.");
        return;
      }
      setIsSending(true);
      try {
        const session = manager.getSession(peer);
        if (!session) throw new Error("No active session");
        const caption =
          text && text.trim().length > 0
            ? text.trim()
            : `Shared ${docIds.length} document${docIds.length !== 1 ? "s" : ""} from "${driveName}"`;
        const msg = await manager.shareDocumentInChat(session, caption, docIds, driveId, driveName);
        addMessage(peer, msg);
        refreshConversations();
        manager.queueMessageForHistory(session, msg);
      } catch (err) {
        console.error("[Chat] Document share failed:", err);
        setError(err instanceof Error ? err.message : "Failed to share documents");
      } finally {
        setIsSending(false);
      }
    },
    [addMessage, refreshConversations],
  );

  const goBack = useCallback(() => {
    setView("conversations");
    setActivePeer(null);
    refreshConversations();
  }, [refreshConversations]);

  return {
    view,
    activePeer,
    messages,
    conversations,
    isReady,
    readiness,
    isSending,
    isHydrating,
    isOpeningConversation,
    uploadingFile,
    isLoadingOlder,
    hasMoreHistory,
    error,
    dismissError,
    openConversation,
    sendMessage,
    sendFile,
    shareDocuments,
    loadOlderHistory,
    goBack,
  };
}
