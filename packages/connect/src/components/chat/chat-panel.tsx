/**
 * ChatPanel — Discord-style 2-pane chat UI.
 *
 * Left pane: conversation list + new conversation card + search.
 * Right pane: thread header + tabs (Messages / Files) + messages area + composer.
 *
 * Messages are stacked (no bubbles) with avatar + author header + text.
 * Consecutive messages from the same author within 5 minutes are grouped.
 */
import React, { useState, useEffect, useRef } from "react";
import { useChat } from "./use-chat.js";
import { ConversationList } from "./conversation-list.js";
import { MessageItem, groupMessages } from "./message-bubble.js";
import { MessageInput } from "./message-input.js";
import { FilesTab } from "./files-tab.js";
import type { ChatSession } from "./types.js";

const ACCENT = "#2563eb";

type Tab = "messages" | "files";

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const {
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
  } = useChat();

  const [tab, setTab] = useState<Tab>("messages");

  // Get my Swarm signer address, normalized
  const ph = (globalThis as any).window?.ph;
  const myAddress = (
    ph?.swarm?.signerEntry?.ownerAddress
    ?? ph?.swarm?.client?.getOwnerAddress?.()
    ?? ""
  ).toLowerCase();

  // Peer session details for thread header
  const session: ChatSession | undefined = activePeer
    ? ph?.swarm?.chat?.manager?.getSession?.(activePeer)
    : undefined;

  // Reset tab when switching conversations
  useEffect(() => {
    setTab("messages");
  }, [activePeer]);

  if (!isReady) {
    return (
      <PanelShell onClose={onClose}>
        <ChatRequirements />
      </PanelShell>
    );
  }

  const errorBanner = error ? (
    <div className="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2.5">
      <div className="flex items-start gap-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" className="mt-0.5 shrink-0">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <p className="flex-1 text-[12px] leading-relaxed text-red-800">{error}</p>
        <button
          type="button"
          onClick={dismissError}
          className="shrink-0 text-red-400 hover:text-red-600"
          title="Dismiss"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  ) : null;

  const peerLabel = activePeer
    ? session?.peerDisplayName ?? `${activePeer.slice(0, 10)}…${activePeer.slice(-4)}`
    : "";

  return (
    <PanelShell onClose={onClose}>
      {errorBanner}
      <div className="flex min-h-0 flex-1">
        <ConversationList
          conversations={conversations}
          activePeer={activePeer}
          onSelect={openConversation}
          onNewConversation={openConversation}
        />

        <main className="flex min-w-0 flex-1 flex-col bg-white">
          {!activePeer ? (
            <EmptyThread />
          ) : isOpeningConversation ? (
            <OpeningConversation peerLabel={peerLabel} />
          ) : (
            <>
              <ThreadHeader peerAddress={activePeer} peerLabel={peerLabel} online={session?.ready ?? false} />
              <Tabs tab={tab} onChange={setTab} />

              {tab === "messages" && (
                <>
                  <MessagesArea
                    messages={messages}
                    myAddress={myAddress}
                    activePeer={activePeer}
                    peerLabel={peerLabel}
                    isHydrating={isHydrating}
                    isLoadingOlder={isLoadingOlder}
                    hasMoreHistory={hasMoreHistory}
                    onLoadOlder={loadOlderHistory}
                  />
                  <MessageInput
                    onSend={sendMessage}
                    onSendFile={sendFile}
                    peerLabel={peerLabel}
                    isSending={isSending}
                  />
                </>
              )}

              {tab === "files" && (
                <FilesTab messages={messages} myAddress={myAddress} />
              )}
            </>
          )}
        </main>
      </div>
    </PanelShell>
  );
}

// ─── Panel shell (close button + content) ──────────────────────

function PanelShell({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full flex-col bg-gray-50">
      <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2.5">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
          <h2 className="text-sm font-semibold text-gray-900">Chat</h2>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            PSS · Swarm
          </span>
        </div>
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
      {children}
    </div>
  );
}

// ─── Thread header (peer info above messages) ──────────────────

function ThreadHeader({
  peerAddress,
  peerLabel,
  online,
}: {
  peerAddress: string;
  peerLabel: string;
  online: boolean;
}) {
  const initials = getInitials(peerLabel);
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-5 py-3">
      <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-200 text-sm font-semibold text-gray-600">
        {initials}
        {online && (
          <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white bg-green-500" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[15px] font-semibold text-gray-900">
          <span className="truncate">{peerLabel}</span>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            PSS · Swarm
          </span>
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-gray-400">
          {peerAddress} · Encrypted direct message
        </div>
      </div>
    </header>
  );
}

// ─── Tabs ──────────────────────────────────────────────────────

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <div className="flex shrink-0 gap-5 border-b border-gray-200 bg-white px-5">
      <TabButton label="Messages" active={tab === "messages"} onClick={() => onChange("messages")} />
      <TabButton label="Files" active={tab === "files"} onClick={() => onChange("files")} />
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mb-px border-b-2 px-1 py-3 text-[13px] font-semibold transition-colors"
      style={{
        borderColor: active ? ACCENT : "transparent",
        color: active ? ACCENT : "#9ca3af",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.color = "#6b7280";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.color = "#9ca3af";
      }}
    >
      {label}
    </button>
  );
}

// ─── Messages area ─────────────────────────────────────────────

function MessagesArea({
  messages,
  myAddress,
  activePeer,
  peerLabel,
  isHydrating,
  isLoadingOlder,
  hasMoreHistory,
  onLoadOlder,
}: {
  messages: any[];
  myAddress: string;
  activePeer: string;
  peerLabel: string;
  isHydrating: boolean;
  isLoadingOlder: boolean;
  hasMoreHistory: boolean;
  onLoadOlder: () => void | Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(0);
  const prevActivePeerRef = useRef<string | null>(null);
  const prevScrollHeightRef = useRef(0);

  // Auto-scroll behavior:
  // - On conversation switch: scroll to bottom
  // - On new message at bottom: scroll to bottom
  // - On older messages loaded (prepend): preserve scroll position
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const peerChanged = prevActivePeerRef.current !== activePeer;
    const oldCount = prevMessageCountRef.current;
    const newCount = messages.length;

    requestAnimationFrame(() => {
      if (peerChanged) {
        // Fresh conversation — scroll to bottom
        el.scrollTop = el.scrollHeight;
      } else if (newCount > oldCount) {
        // Messages added. Detect if they were prepended (loadOlder) or appended.
        // After loadOlder, scrollHeight grows but we want to keep scroll position.
        const wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        const scrollHeightDelta = el.scrollHeight - prevScrollHeightRef.current;

        if (isLoadingOlder || (!wasNearBottom && scrollHeightDelta > 0)) {
          // Preserve scroll position when older messages are prepended
          el.scrollTop = el.scrollTop + scrollHeightDelta;
        } else {
          // New message appended or user was at bottom — scroll to bottom
          el.scrollTop = el.scrollHeight;
        }
      }

      prevMessageCountRef.current = newCount;
      prevActivePeerRef.current = activePeer;
      prevScrollHeightRef.current = el.scrollHeight;
    });
  }, [messages.length, activePeer, isLoadingOlder]);

  // Detect scroll to top → load older messages
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (isLoadingOlder || !hasMoreHistory || isHydrating) return;
    const target = e.currentTarget;
    if (target.scrollTop < 80) {
      // Near top — trigger load older
      void onLoadOlder();
    }
  };

  const sections = groupMessages(messages, myAddress, activePeer);

  // Empty conversation but hydrating → show a centered loader
  if (messages.length === 0 && isHydrating) {
    return (
      <div className="flex flex-1 items-center justify-center bg-white px-6 text-center">
        <div>
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-blue-50">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" className="animate-spin">
              <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
            </svg>
          </div>
          <p className="text-sm font-medium text-gray-600">Loading messages from Swarm…</p>
          <p className="mt-0.5 text-xs text-gray-400">
            Fetching encrypted history from both feeds.
          </p>
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center bg-white px-6 text-center">
        <div>
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round">
              <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12c0 1.82.487 3.53 1.338 5L2 22l5-1.338A9.956 9.956 0 0012 22z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-gray-600">Start the conversation</p>
          <p className="mt-0.5 text-xs text-gray-400">
            End-to-end encrypted via Swarm PSS
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto bg-white py-2">
      {/* Hydrating indicator — stays at top while history is loading, even
          if we already have local messages showing */}
      {isHydrating && (
        <div className="sticky top-0 z-10 flex items-center justify-center gap-2 border-b border-blue-100 bg-blue-50/70 px-4 py-1.5 backdrop-blur-sm">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2.5" className="animate-spin">
            <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
          </svg>
          <span className="text-[11px] font-medium text-blue-700">
            Syncing history from Swarm…
          </span>
        </div>
      )}

      {/* Top-of-list: "Load older" banner / loading indicator / end-of-history */}
      {!isHydrating && hasMoreHistory && (
        <div className="flex items-center justify-center py-2">
          {isLoadingOlder ? (
            <div className="flex items-center gap-2 rounded-full bg-gray-50 px-3 py-1.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2.5" className="animate-spin">
                <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
              </svg>
              <span className="text-[11px] font-medium text-gray-500">
                Loading older messages…
              </span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void onLoadOlder()}
              className="rounded-full bg-gray-50 px-3 py-1.5 text-[11px] font-medium text-gray-500 hover:bg-gray-100"
            >
              Load older messages
            </button>
          )}
        </div>
      )}
      {!isHydrating && !hasMoreHistory && messages.length > 0 && (
        <div className="flex items-center justify-center py-3 text-[10px] uppercase tracking-wider text-gray-300">
          Beginning of conversation
        </div>
      )}

      {sections.map((section) => (
        <div key={section.dateLabel}>
          <DateDivider label={section.dateLabel} />
          {section.messages.map(({ message, isContinuation }) => {
            const isOwn = activePeer && message.to
              ? message.to.toLowerCase() === activePeer.toLowerCase()
              : message.from.toLowerCase() === myAddress;
            const authorDisplay = isOwn
              ? "You"
              : peerLabel || `${message.from.slice(0, 10)}…${message.from.slice(-4)}`;
            return (
              <MessageItem
                key={message.id}
                message={message}
                isOwn={isOwn}
                isContinuation={isContinuation}
                authorDisplay={authorDisplay}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function DateDivider({ label }: { label: string }) {
  return (
    <div className="mx-5 my-3 flex items-center gap-3">
      <div className="h-px flex-1 bg-gray-200" />
      <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
        {label}
      </span>
      <div className="h-px flex-1 bg-gray-200" />
    </div>
  );
}

// ─── Empty state when no conversation selected ─────────────────

// ─── Requirements screen (shown when ChatManager can't initialize) ─────

function Acronym({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className="cursor-help font-semibold text-gray-700 underline decoration-dotted decoration-gray-400 underline-offset-[3px]"
    >
      {children}
    </span>
  );
}

function ChatRequirements() {
  const [showConfig, setShowConfig] = useState(false);

  const requirements: Array<{ title: string; body: React.ReactNode }> = [
    {
      title: "Full Bee node, connected & synced",
      body: (
        <>
          Chat runs on{" "}
          <Acronym title="Postal Service over Swarm — sends encrypted, anonymous messages between Bee nodes as Trojan chunks.">
            PSS
          </Acronym>{" "}
          and{" "}
          <Acronym title="Graffiti Single Owner Chunks — many-to-one, sub-second notifications delivered directly to a target node's neighborhood.">
            GSOC
          </Acronym>
          {" "}— both require a full node that participates in the neighborhood.
          Light nodes can't receive messages. Give a fresh node a few minutes
          to warm up.
        </>
      ),
    },
    {
      title: "API reachable from your browser",
      body: "Chat opens WebSockets to /pss/subscribe and /gsoc/subscribe on your Bee API (port 1633 by default). CORS must allow your Connect origin.",
    },
    {
      title: "P2P WebSocket transport enabled & publicly reachable",
      body: "PSS messages travel between nodes over libp2p WebSockets. Ports 1634 (TCP) and 1635 (WSS) must be open inbound, with NAT addresses advertising your public IP.",
    },
    {
      title: "Mutable postage stamp with healthy TTL",
      body: "Messages and history pages need a usable stamp. Mutable stamps reuse buckets on updates — immutable stamps exhaust quickly.",
    },
  ];

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50 px-6 py-8">
      <div className="mx-auto max-w-md">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-50">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
          </div>
          <div>
            <h3 className="text-[15px] font-semibold text-gray-900">Chat is not ready yet</h3>
            <p className="text-xs text-gray-500">
              Powered by Swarm{" "}
              <Acronym title="Postal Service over Swarm — sends encrypted, anonymous messages between Bee nodes as Trojan chunks.">
                PSS
              </Acronym>
              {" + "}
              <Acronym title="Graffiti Single Owner Chunks — many-to-one, sub-second notifications delivered directly to a target node's neighborhood.">
                GSOC
              </Acronym>
            </p>
          </div>
        </div>

        <p className="mb-4 text-[13px] leading-relaxed text-gray-600">
          Chat is fully peer-to-peer — no servers between you and the other side.
          It only works when your Bee node is a full, publicly reachable node. Once
          it is, your Swarm profile is published automatically when you open
          Settings after logging in with Renown.
        </p>

        <ol className="space-y-3">
          {requirements.map((r, i) => (
            <li
              key={r.title}
              className="rounded-lg border border-gray-200 bg-white p-3"
            >
              <div className="flex items-start gap-3">
                <span
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                  style={{ backgroundColor: ACCENT }}
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-gray-900">{r.title}</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-gray-500">{r.body}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-5 rounded-lg border border-gray-200 bg-white">
          <button
            type="button"
            onClick={() => setShowConfig(v => !v)}
            className="flex w-full items-center justify-between px-3 py-2.5 text-left"
          >
            <span className="text-[13px] font-semibold text-gray-900">
              Bee node configuration
            </span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-gray-400 transition-transform"
              style={{ transform: showConfig ? "rotate(180deg)" : undefined }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {showConfig && (
            <div className="border-t border-gray-200 px-3 py-3">
              <p className="mb-2 text-[12px] leading-relaxed text-gray-600">
                Minimum keys required for chat. Add these to your Bee config (or
                the equivalent <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px]">BEE_*</code> env
                vars in docker-compose):
              </p>
              <pre className="overflow-x-auto rounded-md bg-gray-900 p-3 font-mono text-[11px] leading-relaxed text-gray-100">{`full-node: true
api-addr: :1633
cors-allowed-origins: '*'

# P2P + WebSocket transport
p2p-addr: :1634
p2p-ws-enable: true
p2p-wss-enable: true
p2p-wss-addr: :1635
nat-addr:     <YOUR_PUBLIC_IP>:1634
nat-wss-addr: <YOUR_PUBLIC_IP>:1635

# AutoTLS — recommended (valid WSS cert without manual renewals)
autotls-domain: libp2p.direct
autotls-registration-endpoint: https://registration.libp2p.direct
autotls-ca-endpoint: https://acme-v02.api.letsencrypt.org/directory

# Storage participation
swap-enable: true
storage-incentives-enable: true
mainnet: true`}</pre>
              <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
                Also open TCP <strong>1634</strong> and <strong>1635</strong>{" "}
                inbound on your firewall/router so other nodes can reach yours.
              </p>
            </div>
          )}
        </div>

        <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50/70 p-3">
          <p className="text-[12px] leading-relaxed text-blue-900">
            <strong className="font-semibold">Tip:</strong> open Swarm Settings →
            Inspector to verify stamp health, P2P peer count, and WebSocket
            connectivity. Then close and reopen this panel.
          </p>
        </div>
      </div>
    </div>
  );
}

function OpeningConversation({ peerLabel }: { peerLabel: string }) {
  const display = peerLabel
    ? peerLabel.length > 24
      ? `${peerLabel.slice(0, 10)}…${peerLabel.slice(-6)}`
      : peerLabel
    : "peer";
  return (
    <div className="flex flex-1 items-center justify-center bg-white px-6 text-center">
      <div>
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" className="animate-spin">
            <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
          </svg>
        </div>
        <p className="text-sm font-medium text-gray-600">Connecting to {display}…</p>
        <p className="mt-1 text-xs text-gray-400">
          Resolving Swarm profile and setting up encrypted channel.
        </p>
      </div>
    </div>
  );
}

function EmptyThread() {
  return (
    <div className="flex flex-1 items-center justify-center bg-white px-6 text-center">
      <div>
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-blue-50">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.5">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 00-3-3.87" />
            <path d="M16 3.13a4 4 0 010 7.75" />
          </svg>
        </div>
        <p className="text-sm font-medium text-gray-600">No conversation selected</p>
        <p className="mt-1 max-w-[260px] text-xs text-gray-400">
          Pick a conversation from the left, or start a new one with a Swarm ID or ENS name.
        </p>
      </div>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────

function getInitials(name: string): string {
  if (name.startsWith("0x")) return name.slice(2, 4).toUpperCase();
  const parts = name.split(/[.\s…]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
