/**
 * ChatPanel — main chat UI with Swarm orange styling.
 */
import React from "react";
import { useChat } from "./use-chat.js";
import { ConversationList } from "./conversation-list.js";
import { MessageBubble } from "./message-bubble.js";
import { MessageInput } from "./message-input.js";

/** Swarm brand orange */
const SWARM_ORANGE = "#F7931A";

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const {
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
  } = useChat();

  const myAddress = (globalThis as any).window?.ph?.swarm?.signerEntry?.ownerAddress ?? "";

  if (!isReady) {
    return (
      <div className="flex h-full flex-col">
        <ChatHeader title="Swarm Chat" onClose={onClose} />
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div>
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full" style={{ backgroundColor: "#FFF7ED" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={SWARM_ORANGE} strokeWidth="2">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
            </div>
            <p className="text-sm font-medium text-gray-600">Connecting to Swarm...</p>
            <p className="mt-1 text-xs text-gray-400">
              Chat requires a Bee node with a usable stamp.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (view === "conversations") {
    return (
      <div className="flex h-full flex-col">
        <ChatHeader title="Swarm Chat" onClose={onClose} />
        <ConversationList
          conversations={conversations}
          onSelect={openConversation}
          onNewConversation={openConversation}
        />
      </div>
    );
  }

  // Thread view
  const peerDisplay = activePeer
    ? `${activePeer.slice(0, 8)}...${activePeer.slice(-4)}`
    : "Chat";

  return (
    <div className="flex h-full flex-col">
      <ChatHeader
        title={peerDisplay}
        onClose={onClose}
        onBack={goBack}
      />
      <div className="flex-1 overflow-y-auto bg-orange-50/30 px-3 py-2">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full" style={{ backgroundColor: "#FFF7ED" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={SWARM_ORANGE} strokeWidth="1.5" strokeLinecap="round">
                <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12c0 1.82.487 3.53 1.338 5L2 22l5-1.338A9.956 9.956 0 0012 22z" />
              </svg>
            </div>
            <p className="text-sm text-gray-400">Start the conversation</p>
            <p className="mt-0.5 text-xs text-gray-300">End-to-end encrypted via Swarm PSS</p>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isOwn={msg.from.toLowerCase() === myAddress.toLowerCase()}
          />
        ))}
      </div>
      <MessageInput
        onSend={sendMessage}
        onSendFile={sendFile}
        isSending={isSending}
      />
    </div>
  );
}

function ChatHeader({
  title,
  onClose,
  onBack,
}: {
  title: string;
  onClose: () => void;
  onBack?: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2.5"
      style={{
        background: `linear-gradient(135deg, ${SWARM_ORANGE}, #E8820F)`,
      }}
    >
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="flex h-7 w-7 items-center justify-center rounded-full text-white/80 hover:bg-white/20 hover:text-white"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}
      <div className="flex flex-1 items-center gap-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" opacity="0.8">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
        <h2 className="flex-1 truncate text-sm font-semibold text-white">{title}</h2>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="flex h-7 w-7 items-center justify-center rounded-full text-white/70 hover:bg-white/20 hover:text-white"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
