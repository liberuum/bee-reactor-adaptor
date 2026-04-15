/**
 * Conversation list — shows all active chat sessions.
 */
import React, { useState } from "react";
import type { ConversationSummary } from "./types.js";

export function ConversationList({
  conversations,
  onSelect,
  onNewConversation,
}: {
  conversations: ConversationSummary[];
  onSelect: (peerAddress: string) => void;
  onNewConversation: (peerAddress: string) => void;
}) {
  const [newPeerInput, setNewPeerInput] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);

  const handleStartChat = () => {
    const addr = newPeerInput.trim();
    if (!addr) return;
    onNewConversation(addr);
    setNewPeerInput("");
    setShowNewChat(false);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">Conversations</h2>
        <button
          type="button"
          onClick={() => setShowNewChat(!showNewChat)}
          className="flex h-7 w-7 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
          title="New conversation"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {showNewChat && (
        <div className="border-b border-gray-100 px-4 py-2">
          <input
            type="text"
            value={newPeerInput}
            onChange={(e) => setNewPeerInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleStartChat()}
            placeholder="Enter Swarm ID (0x...)"
            className="w-full rounded border border-gray-200 px-2 py-1.5 text-xs outline-none focus:border-blue-400"
            autoFocus
          />
          <button
            type="button"
            onClick={handleStartChat}
            disabled={!newPeerInput.trim()}
            className="mt-1.5 w-full rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Start Chat
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 && !showNewChat && (
          <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
            <p className="text-sm text-gray-400">No conversations yet</p>
            <button
              type="button"
              onClick={() => setShowNewChat(true)}
              className="mt-2 text-xs text-blue-600 hover:underline"
            >
              Start a new conversation
            </button>
          </div>
        )}
        {conversations.map((conv) => (
          <button
            key={conv.peerAddress}
            type="button"
            onClick={() => onSelect(conv.peerAddress)}
            className="flex w-full items-center gap-3 border-b border-gray-50 px-4 py-3 text-left hover:bg-gray-50"
          >
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-bold text-gray-500">
              {conv.peerDisplayName?.[0]?.toUpperCase() || conv.peerAddress.slice(2, 4).toUpperCase()}
              {conv.isOnline && (
                <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-green-500" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-gray-900">
                {conv.peerDisplayName || `${conv.peerAddress.slice(0, 8)}...${conv.peerAddress.slice(-4)}`}
              </p>
              {conv.lastMessage && (
                <p className="truncate text-xs text-gray-400">{conv.lastMessage}</p>
              )}
            </div>
            {conv.lastMessageTime && (
              <span className="shrink-0 text-xs text-gray-300">
                {formatRelativeTime(conv.lastMessageTime)}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
