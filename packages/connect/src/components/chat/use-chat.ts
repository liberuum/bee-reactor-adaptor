/**
 * React hook for managing chat state.
 * Bridges the adapter's ChatManager with React component state.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import type { ChatMessage, ChatSession, ConversationSummary, GsocNotification, ChatView } from "./types.js";

/** Global chat state exposed via window.ph.swarm.chat */
interface SwarmChatState {
  manager: any; // ChatManager from adapter
  sessions: Map<string, ChatSession>;
}

function getChat(): SwarmChatState | null {
  const ph = (globalThis as any).window?.ph;
  return ph?.swarm?.chat ?? null;
}

export function useChat() {
  const [view, setView] = useState<ChatView>("conversations");
  const [activePeer, setActivePeer] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  // Check if chat manager is available
  useEffect(() => {
    const check = () => {
      const chat = getChat();
      if (chat?.manager) {
        setIsReady(true);

        // Subscribe to incoming messages
        if (!unsubRef.current) {
          unsubRef.current = chat.manager.onMessage((msg: ChatMessage) => {
            setMessages(prev => [...prev, msg]);
            // Update conversation list
            updateConversations(chat);
          });
        }

        updateConversations(chat);
      }
    };

    check();
    const interval = setInterval(check, 2000);
    return () => {
      clearInterval(interval);
      unsubRef.current?.();
    };
  }, []);

  const updateConversations = useCallback((chat: SwarmChatState) => {
    const sessions = chat.manager.listSessions() as ChatSession[];
    const summaries: ConversationSummary[] = sessions.map(s => ({
      peerAddress: s.peerAddress,
      peerDisplayName: s.peerDisplayName,
      lastMessage: undefined,
      lastMessageTime: s.lastActivity,
      unreadCount: 0,
      isOnline: s.ready,
    }));
    setConversations(summaries);
  }, []);

  const openConversation = useCallback(async (peerAddress: string) => {
    const chat = getChat();
    if (!chat?.manager) return;

    setActivePeer(peerAddress);
    setView("thread");
    setMessages([]);

    // Start or resume session
    try {
      await chat.manager.startSession(peerAddress, { skipGsoc: true });
    } catch (err) {
      console.warn("[Chat] Failed to start session:", err);
    }
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const chat = getChat();
    if (!chat?.manager || !activePeer) return;

    setIsSending(true);
    try {
      const session = chat.manager.getSession(activePeer);
      if (!session) throw new Error("No active session");

      const msg = await chat.manager.sendMessage(session, text);
      setMessages(prev => [...prev, msg]);
    } catch (err) {
      console.error("[Chat] Send failed:", err);
    } finally {
      setIsSending(false);
    }
  }, [activePeer]);

  const sendFile = useCallback(async (file: File, text?: string) => {
    const chat = getChat();
    if (!chat?.manager || !activePeer) return;

    setIsSending(true);
    try {
      const session = chat.manager.getSession(activePeer);
      if (!session) throw new Error("No active session");

      const data = new Uint8Array(await file.arrayBuffer());
      const msg = await chat.manager.shareFileInChat(
        session,
        text || file.name,
        data,
        file.name,
        file.type || "application/octet-stream",
      );
      setMessages(prev => [...prev, msg]);
    } catch (err) {
      console.error("[Chat] File send failed:", err);
    } finally {
      setIsSending(false);
    }
  }, [activePeer]);

  const goBack = useCallback(() => {
    setView("conversations");
    setActivePeer(null);
    setMessages([]);
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
