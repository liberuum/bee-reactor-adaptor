/**
 * Conversation list with Swarm orange styling.
 */
import React, { useState } from "react";
import type { ConversationSummary } from "./types.js";

const SWARM_ORANGE = "#F7931A";

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
      {/* New conversation toggle */}
      <div className="border-b border-orange-100 px-3 py-2">
        <button
          type="button"
          onClick={() => setShowNewChat(!showNewChat)}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-orange-50"
          style={{ color: SWARM_ORANGE }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Conversation
        </button>
      </div>

      {showNewChat && (
        <div className="border-b border-orange-100 bg-orange-50/50 px-4 py-3">
          <label className="mb-1 block text-xs font-medium text-gray-500">
            Swarm ID or ENS name
          </label>
          <input
            type="text"
            value={newPeerInput}
            onChange={(e) => setNewPeerInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleStartChat()}
            placeholder="0xadbA7C2F..."
            className="w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400 focus:ring-1 focus:ring-orange-200"
            autoFocus
          />
          <button
            type="button"
            onClick={handleStartChat}
            disabled={!newPeerInput.trim()}
            className="mt-2 w-full rounded-lg px-3 py-2 text-sm font-medium text-white transition-colors disabled:opacity-40"
            style={{ backgroundColor: SWARM_ORANGE }}
          >
            Start Chat
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 && !showNewChat && (
          <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full" style={{ backgroundColor: "#FFF7ED" }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={SWARM_ORANGE} strokeWidth="1.5">
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 00-3-3.87" />
                <path d="M16 3.13a4 4 0 010 7.75" />
              </svg>
            </div>
            <p className="text-sm font-medium text-gray-500">No conversations yet</p>
            <p className="mt-1 text-xs text-gray-400">
              Start chatting with another Swarm user
            </p>
          </div>
        )}
        {conversations.map((conv) => (
          <button
            key={conv.peerAddress}
            type="button"
            onClick={() => onSelect(conv.peerAddress)}
            className="flex w-full items-center gap-3 border-b border-orange-50 px-4 py-3 text-left transition-colors hover:bg-orange-50/50"
          >
            <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white" style={{ backgroundColor: SWARM_ORANGE }}>
              {conv.peerDisplayName?.[0]?.toUpperCase() || conv.peerAddress.slice(2, 4).toUpperCase()}
              {conv.isOnline && (
                <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-green-500" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-gray-800">
                {conv.peerDisplayName || `${conv.peerAddress.slice(0, 10)}...${conv.peerAddress.slice(-4)}`}
              </p>
              {conv.lastMessage ? (
                <p className="truncate text-xs text-gray-400">{conv.lastMessage}</p>
              ) : (
                <p className="text-xs text-gray-300">Tap to open</p>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {conv.lastMessageTime && (
                <span className="text-xs text-gray-300">
                  {formatRelativeTime(conv.lastMessageTime)}
                </span>
              )}
              {conv.unreadCount > 0 && (
                <span
                  className="flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold text-white"
                  style={{ backgroundColor: "#F7931A" }}
                >
                  {conv.unreadCount}
                </span>
              )}
            </div>
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
