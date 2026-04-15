/**
 * ChatPanel — main chat UI component.
 *
 * Two views:
 * - Conversation list (default) — shows all active chats
 * - Message thread — shows messages for a specific peer
 *
 * Renders as a slide-out panel from the sidebar.
 */
import React from "react";
import { useChat } from "./use-chat.js";
import { ConversationList } from "./conversation-list.js";
import { MessageBubble } from "./message-bubble.js";
import { MessageInput } from "./message-input.js";

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
        <ChatHeader title="Chat" onClose={onClose} />
        <div className="flex flex-1 items-center justify-center px-4 text-center">
          <div>
            <p className="text-sm text-gray-400">Connecting to Swarm...</p>
            <p className="mt-1 text-xs text-gray-300">
              Chat requires a connected Bee node with a usable stamp.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (view === "conversations") {
    return (
      <div className="flex h-full flex-col">
        <ChatHeader title="Chat" onClose={onClose} />
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
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-gray-300">
              Send a message to start the conversation.
              <br />
              <span className="text-xs">Messages are end-to-end encrypted via PSS.</span>
            </p>
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
    <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2.5">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="flex h-7 w-7 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}
      <h2 className="flex-1 truncate text-sm font-semibold text-gray-900">{title}</h2>
      <button
        type="button"
        onClick={onClose}
        className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
