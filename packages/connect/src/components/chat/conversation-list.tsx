/**
 * Conversation list — left sidebar pane in the chat panel.
 * Settings-style cards, blue accent active state.
 */
import React, { useState } from "react";
import type { ConversationSummary } from "./types.js";

const ACCENT = "#2563eb";

function getMySwarmId(): string {
  // Use the Swarm SIGNER address (derived from the wallet signature over
  // the origin), NOT the Ethereum wallet address. Chat history feeds and
  // public-profile feeds are keyed by the Swarm signer — copying the
  // wallet address here leaves peers unable to look us up (they hit
  // "No Swarm profile found for 0x…").
  const ph = (globalThis as any).window?.ph;
  return ph?.swarm?.client?.getOwnerAddress?.()
    ?? ph?.swarm?.signerEntry?.swarmAddress
    ?? "";
}

export function ConversationList({
  conversations,
  activePeer,
  onSelect,
  onNewConversation,
}: {
  conversations: ConversationSummary[];
  activePeer: string | null;
  onSelect: (peerAddress: string) => void;
  onNewConversation: (peerAddress: string) => void;
}) {
  const [newPeerInput, setNewPeerInput] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [search, setSearch] = useState("");

  const handleStartChat = () => {
    const addr = newPeerInput.trim();
    if (!addr) return;
    onNewConversation(addr);
    setNewPeerInput("");
    setShowNewChat(false);
  };

  const filtered = search
    ? conversations.filter(c => {
        const q = search.toLowerCase();
        return (
          c.peerAddress.toLowerCase().includes(q) ||
          (c.peerDisplayName ?? "").toLowerCase().includes(q)
        );
      })
    : conversations;

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="flex flex-1 flex-col gap-3 overflow-hidden p-4">
        {/* Your Swarm ID — copyable for sharing */}
        <MySwarmIdCard />

        {/* Section: New conversation card */}
        <div>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            Direct messages
          </h3>
          <div className="rounded-lg border border-gray-100 bg-white p-3">
            {!showNewChat ? (
              <button
                type="button"
                onClick={() => setShowNewChat(true)}
                className="w-full rounded-md py-2 text-xs font-semibold text-white transition-colors"
                style={{ backgroundColor: ACCENT }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#1d4ed8")}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = ACCENT)}
              >
                New conversation
              </button>
            ) : (
              <div className="space-y-2">
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                  Swarm ID
                </label>
                <input
                  type="text"
                  value={newPeerInput}
                  onChange={(e) => setNewPeerInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleStartChat()}
                  placeholder="0x..."
                  className="w-full rounded-md border border-gray-300 px-2 py-1.5 font-mono text-xs outline-none focus:border-blue-400"
                  autoFocus
                />
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={handleStartChat}
                    disabled={!newPeerInput.trim()}
                    className="flex-1 rounded-md py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                    style={{ backgroundColor: ACCENT }}
                  >
                    Start
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowNewChat(false); setNewPeerInput(""); }}
                    className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <p className="mt-2.5 text-[11px] leading-snug text-gray-400">
              Paste the peer's <strong className="text-gray-600">Swarm ID</strong> (not their wallet address).
              They can find it in Swarm Settings → Your Swarm ID.
            </p>
          </div>
        </div>

        {/* Search */}
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search people…"
          className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-2 text-[13px] outline-none placeholder:text-gray-400 focus:border-blue-400"
        />

        {/* Conversation items */}
        <div className="-mx-1 flex-1 overflow-y-auto px-1">
          {filtered.length === 0 && (
            <div className="px-2 py-8 text-center text-xs text-gray-400">
              {conversations.length === 0
                ? "No conversations yet"
                : "No matches"}
            </div>
          )}
          {filtered.map((conv) => {
            const isActive = conv.peerAddress === activePeer;
            return (
              <button
                key={conv.peerAddress}
                type="button"
                onClick={() => onSelect(conv.peerAddress)}
                className={`mb-1 flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2.5 text-left transition-colors ${
                  isActive
                    ? "border-blue-200 bg-blue-50"
                    : "border-transparent hover:bg-gray-50"
                }`}
              >
                <Avatar name={conv.peerDisplayName || conv.peerAddress} online={conv.isOnline} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-gray-900">
                    {conv.peerDisplayName || `${conv.peerAddress.slice(0, 10)}…${conv.peerAddress.slice(-4)}`}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-gray-400">
                    {conv.lastMessage ?? "Start a message…"}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {conv.lastMessageTime && (
                    <span className="text-[11px] text-gray-400">
                      {formatRelativeTime(conv.lastMessageTime)}
                    </span>
                  )}
                  {conv.unreadCount > 0 && !isActive && (
                    <span
                      className="flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
                      style={{ backgroundColor: ACCENT }}
                    >
                      {conv.unreadCount}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <ClearChatsButton conversationCount={conversations.length} />
      </div>
    </aside>
  );
}

/**
 * Wipe all conversations: local caches + chatPeers in the user manifest.
 * Two-step confirm to prevent accidental clicks. Shown disabled when the
 * list is already empty so the button doesn't invite a useless op.
 */
function ClearChatsButton({ conversationCount }: { conversationCount: number }) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  const handleClear = async () => {
    const ph = (globalThis as any).window?.ph;
    const fn = ph?.swarm?.clearChats;
    if (typeof fn !== "function") {
      console.warn("[Chat UI] clearChats not available on ph.swarm");
      return;
    }
    setWorking(true);
    try {
      await fn();
    } catch (err) {
      console.warn("[Chat UI] clearChats failed:", err instanceof Error ? err.message : err);
    } finally {
      setWorking(false);
      setConfirming(false);
    }
  };

  const disabled = conversationCount === 0 && !confirming;

  return (
    <div className="mt-3 border-t border-gray-100 pt-3">
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={disabled}
          className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-gray-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-gray-200 disabled:hover:bg-white disabled:hover:text-gray-500"
          title={disabled ? "No conversations to clear" : "Wipe all conversations from this browser and the user manifest"}
        >
          Clear all chats…
        </button>
      ) : (
        <div className="space-y-1.5">
          <p className="px-1 text-[10.5px] leading-snug text-gray-500">
            Remove all conversations from this browser and your Swarm manifest?
            Peers can still reach you with new messages.
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={handleClear}
              disabled={working}
              className="flex-1 rounded-md bg-red-600 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-60"
            >
              {working ? "Clearing…" : "Yes, clear"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={working}
              className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MySwarmIdCard() {
  const mySwarmId = getMySwarmId();
  const [copied, setCopied] = useState(false);

  if (!mySwarmId) return null;

  const short = `${mySwarmId.slice(0, 10)}…${mySwarmId.slice(-6)}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(mySwarmId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
        Your Swarm ID
      </h3>
      <button
        type="button"
        onClick={handleCopy}
        title={mySwarmId}
        className="flex w-full items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-left transition-colors hover:border-blue-200 hover:bg-blue-50"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px] font-semibold text-gray-700">
            {short}
          </div>
          <div className="mt-0.5 text-[10px] text-gray-400">
            {copied ? "Copied!" : "Click to copy · share with peers"}
          </div>
        </div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-gray-400">
          {copied ? (
            <polyline points="20 6 9 17 4 12" />
          ) : (
            <>
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </>
          )}
        </svg>
      </button>
    </div>
  );
}

function Avatar({ name, online }: { name: string; online: boolean }) {
  const initials = getInitials(name);
  return (
    <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-600">
      {initials}
      {online && (
        <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white bg-green-500" />
      )}
    </div>
  );
}

function getInitials(name: string): string {
  if (name.startsWith("0x")) return name.slice(2, 4).toUpperCase();
  const parts = name.split(/[.\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { weekday: "short" });
}
