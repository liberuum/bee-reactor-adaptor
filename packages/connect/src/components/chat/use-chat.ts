/**
 * React hook for managing chat state.
 * Bridges the adapter's ChatManager with React component state.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import type { ChatMessage, ChatSession, ConversationSummary, ChatView } from "./types.js";

function getManager(): any | null {
  const ph = (globalThis as any).window?.ph;
  return ph?.swarm?.chat?.manager ?? null;
}

function getMyAddress(): string {
  const ph = (globalThis as any).window?.ph;
  return ph?.swarm?.signerEntry?.ownerAddress
    ?? ph?.swarm?.client?.getOwnerAddress?.()
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
  const [isReady, setIsReady] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isHydrating, setIsHydrating] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True from the moment a conversation is clicked until startSession resolves.
  // UI should show a "Connecting…" placeholder, not the empty state.
  const [isOpeningConversation, setIsOpeningConversation] = useState(false);

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

    // Collect all peers from both sessions and stored messages
    const allPeers = new Set<string>();
    if (manager) {
      const sessions = manager.listSessions() as ChatSession[];
      sessions.forEach((s: ChatSession) => allPeers.add(s.peerAddress));
    }
    for (const peer of messagesRef.current.keys()) {
      allPeers.add(peer);
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

    const interval = setInterval(() => {
      const manager = getManager();
      if (!manager) return;

      if (!isReady) setIsReady(true);

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
      }

      refreshConversations();
    }, 1500);

    return () => {
      clearInterval(interval);
      if (unsubscribe) {
        unsubscribe();
        subscribedRef.current = false;
      }
    };
    // `isReady` is intentionally NOT in the dep array — it would tear down
    // and recreate the subscription on first ready, doubling event handlers
    // during the transition. setIsReady(true) is idempotent (React bails).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addMessage, refreshConversations]);

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

    try {
      const session = await manager.startSession(peerAddress, { skipGsoc: true });
      setIsOpeningConversation(false);
      markRead(peerAddress);
      refreshConversations();

      // Hydrate latest page from Swarm feeds (both parties) — non-blocking.
      // Use an epoch counter so a stale hydration that resolves after the
      // user switched conversations doesn't clobber the spinner / pagination
      // state of the newly active thread.
      const epoch = ++hydrationEpochRef.current;
      setIsHydrating(true);
      setHasMoreHistory(false);
      (async () => {
        try {
          const loaded = await manager.loadHistoryLatest(session, 3);
          cursorsRef.current.set(peerAddress, loaded.cursor);

          if (loaded.messages.length === 0) {
            console.log(`[Chat] No history found on feeds for ${peerAddress.slice(0, 10)}`);
          } else {
            mergeMessages(peerAddress, loaded.messages);
            console.log(`[Chat] Hydrated ${loaded.messages.length} msg(s) from feeds (hasMore=${loaded.hasMore})`);
          }

          if (hydrationEpochRef.current === epoch) setHasMoreHistory(loaded.hasMore);
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

    setIsSending(true);
    try {
      const session = manager.getSession(peer);
      if (!session) throw new Error("No active session");

      const data = new Uint8Array(await file.arrayBuffer());
      const msg = await manager.shareFileInChat(
        session,
        text || file.name,
        data,
        file.name,
        file.type || "application/octet-stream",
      );
      addMessage(peer, msg);
      refreshConversations();

      // Queue for feed persistence (debounced batch write)
      manager.queueMessageForHistory(session, msg);
    } catch (err) {
      console.error("[Chat] File send failed:", err);
    } finally {
      setIsSending(false);
    }
  }, [addMessage, refreshConversations]);

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
    isSending,
    isHydrating,
    isOpeningConversation,
    isLoadingOlder,
    hasMoreHistory,
    error,
    dismissError,
    openConversation,
    sendMessage,
    sendFile,
    loadOlderHistory,
    goBack,
  };
}
