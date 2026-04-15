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

export function useChat() {
  const [view, setView] = useState<ChatView>("conversations");
  const [activePeer, setActivePeer] = useState<string | null>(null);
  const [messagesByPeer, setMessagesByPeer] = useState<Map<string, ChatMessage[]>>(new Map());
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);
  const activePeerRef = useRef<string | null>(null);

  // Keep ref in sync so callbacks see latest value
  activePeerRef.current = activePeer;

  // Current conversation messages
  const messages = activePeer ? (messagesByPeer.get(activePeer) ?? []) : [];

  // Add a message to a peer's message list
  const addMessage = useCallback((peerAddress: string, msg: ChatMessage) => {
    setMessagesByPeer(prev => {
      const next = new Map(prev);
      const existing = next.get(peerAddress) ?? [];
      // Deduplicate by message ID
      if (existing.some(m => m.id === msg.id)) return prev;
      next.set(peerAddress, [...existing, msg]);
      return next;
    });
  }, []);

  // Rebuild conversation list from ChatManager sessions + local messages
  const refreshConversations = useCallback(() => {
    const manager = getManager();
    if (!manager) return;

    const sessions = manager.listSessions() as ChatSession[];
    const summaries: ConversationSummary[] = sessions.map((s: ChatSession) => {
      const peerMsgs = messagesByPeer.get(s.peerAddress) ?? [];
      const lastMsg = peerMsgs[peerMsgs.length - 1];
      const unread = activePeerRef.current === s.peerAddress
        ? 0
        : peerMsgs.filter((m: ChatMessage) => m.from !== ((globalThis as any).window?.ph?.swarm?.signerEntry?.ownerAddress ?? "")).length;
      return {
        peerAddress: s.peerAddress,
        peerDisplayName: s.peerDisplayName,
        lastMessage: lastMsg?.text?.slice(0, 50),
        lastMessageTime: lastMsg?.timestamp ?? s.lastActivity,
        unreadCount: unread,
        isOnline: s.ready,
      };
    });
    setConversations(summaries);
  }, [messagesByPeer]);

  // Check if chat manager is available + subscribe to events
  useEffect(() => {
    const check = () => {
      const manager = getManager();
      if (manager && !isReady) {
        setIsReady(true);
      }
      if (manager && !unsubRef.current) {
        // Subscribe to ALL incoming messages (from any peer)
        unsubRef.current = manager.onMessage((msg: ChatMessage) => {
          const peerAddr = msg.from;
          console.log(`[Chat UI] Message received from ${peerAddr.slice(0, 10)}: "${msg.text.slice(0, 30)}"`);
          addMessage(peerAddr, msg);
        });
      }
      if (manager) {
        refreshConversations();
      }
    };

    check();
    const interval = setInterval(check, 2000);
    return () => {
      clearInterval(interval);
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, [isReady, addMessage, refreshConversations]);

  // Refresh conversation list when messages change
  useEffect(() => {
    refreshConversations();
  }, [messagesByPeer, refreshConversations]);

  const openConversation = useCallback(async (peerAddress: string) => {
    const manager = getManager();
    if (!manager) return;

    setActivePeer(peerAddress);
    setView("thread");

    // Start or resume session
    try {
      await manager.startSession(peerAddress, { skipGsoc: true });
      refreshConversations();
    } catch (err) {
      console.warn("[Chat] Failed to start session:", err);
    }
  }, [refreshConversations]);

  const sendMessage = useCallback(async (text: string) => {
    const manager = getManager();
    if (!manager || !activePeer) return;

    setIsSending(true);
    try {
      const session = manager.getSession(activePeer);
      if (!session) throw new Error("No active session");

      const msg = await manager.sendMessage(session, text);
      addMessage(activePeer, msg);
    } catch (err) {
      console.error("[Chat] Send failed:", err);
    } finally {
      setIsSending(false);
    }
  }, [activePeer, addMessage]);

  const sendFile = useCallback(async (file: File, text?: string) => {
    const manager = getManager();
    if (!manager || !activePeer) return;

    setIsSending(true);
    try {
      const session = manager.getSession(activePeer);
      if (!session) throw new Error("No active session");

      const data = new Uint8Array(await file.arrayBuffer());
      const msg = await manager.shareFileInChat(
        session,
        text || file.name,
        data,
        file.name,
        file.type || "application/octet-stream",
      );
      addMessage(activePeer, msg);
    } catch (err) {
      console.error("[Chat] File send failed:", err);
    } finally {
      setIsSending(false);
    }
  }, [activePeer, addMessage]);

  const goBack = useCallback(() => {
    setView("conversations");
    setActivePeer(null);
  }, []);

  return {
    view,
    activePeer,
    messages,
    conversations,
    isReady,
    isSending,
    openConversation,
    sendMessage,
    sendFile,
    goBack,
  };
}
