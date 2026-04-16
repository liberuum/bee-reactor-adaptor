import { DriveIcon } from "@powerhousedao/connect/components";
import { connectConfig } from "@powerhousedao/connect/config";
import {
  ConnectSidebar,
  ConnectTooltipProvider,
  SidebarAddDriveItem,
  SidebarItem,
  useEns,
} from "@powerhousedao/design-system/connect";

import {
  logout,
  openRenown,
  setSelectedDrive,
  showPHModal,
  useDrives,
  useInspectorEnabled,
  useSelectedDriveSafe,
  useUser,
} from "@powerhousedao/reactor-browser";
import { useState, useEffect, useRef, useCallback } from "react";
import { ErrorBoundary } from "./error-boundary.js";
import { ChatPanel } from "./chat/index.js";
import { useUnreadCount } from "./chat/use-unread-count.js";

const CHAT_WIDTH_KEY = "swarm:chatPanelWidth";
const CHAT_WIDTH_DEFAULT = 820;
const CHAT_WIDTH_MIN = 520;
const CHAT_WIDTH_MAX_PX = 1600;

function loadChatWidth(): number {
  try {
    const stored = localStorage.getItem(CHAT_WIDTH_KEY);
    if (!stored) return CHAT_WIDTH_DEFAULT;
    const n = Number.parseInt(stored, 10);
    if (Number.isFinite(n) && n >= CHAT_WIDTH_MIN) return n;
  } catch {}
  return CHAT_WIDTH_DEFAULT;
}

function saveChatWidth(w: number): void {
  try { localStorage.setItem(CHAT_WIDTH_KEY, String(Math.round(w))); } catch {}
}

export function Sidebar() {
  const user = useUser();
  const drives = useDrives();
  const [selectedDrive] = useSelectedDriveSafe();
  const inspectorEnabled = useInspectorEnabled();
  const connectDebug = localStorage.getItem("CONNECT_DEBUG") === "true";
  const [chatOpen, setChatOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState<number>(loadChatWidth);
  const [isDragging, setIsDragging] = useState(false);
  const chatPanelRef = useRef<HTMLDivElement>(null);
  const chatButtonRef = useRef<HTMLButtonElement>(null);
  const unreadCount = useUnreadCount();

  const closeChat = useCallback(() => setChatOpen(false), []);

  // Drag-to-resize handler
  useEffect(() => {
    if (!isDragging) return;

    const handleMove = (e: PointerEvent) => {
      // Panel starts at left: 56px (sidebar rail). Width = mouseX - 56.
      const maxAllowed = Math.min(CHAT_WIDTH_MAX_PX, window.innerWidth - 56 - 100);
      const next = Math.max(CHAT_WIDTH_MIN, Math.min(maxAllowed, e.clientX - 56));
      setChatWidth(next);
    };

    const handleUp = () => {
      setIsDragging(false);
    };

    document.addEventListener("pointermove", handleMove);
    document.addEventListener("pointerup", handleUp);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isDragging]);

  // Persist width after drag ends (debounce-free — single save on release)
  useEffect(() => {
    if (!isDragging) saveChatWidth(chatWidth);
  }, [isDragging, chatWidth]);

  // Close chat when clicking outside the panel + button
  useEffect(() => {
    if (!chatOpen) return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (chatPanelRef.current?.contains(target)) return;
      if (chatButtonRef.current?.contains(target)) return;
      setChatOpen(false);
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChatOpen(false);
    };

    // Use pointerdown (not click) so we close before modals/buttons fire
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [chatOpen]);

  // Helpers that close chat before opening any modal
  const openModal = useCallback((modal: Parameters<typeof showPHModal>[0]) => {
    setChatOpen(false);
    showPHModal(modal);
  }, []);

  const ensName = user?.ens?.name || user?.profile?.username || undefined;
  const avatarUrl =
    user?.ens?.avatarUrl || user?.profile?.userImage || undefined;

  const ensInfo = useEns(!avatarUrl ? user?.address : undefined);

  const onClickSettings = () => openModal({ type: "settings" });
  const onAddDriveClick = () => openModal({ type: "addDrive" });
  const onInspectorClick = () => openModal({ type: "inspector" });
  const onDebugClick = () => openModal({ type: "debugSettings" });

  const etherscanUrl = user?.address
    ? `https://etherscan.io/address/${user.address}`
    : "";

  return (
    <ConnectTooltipProvider>
      {/* Chat panel — slides out from sidebar (2-pane: conversations + thread) */}
      {chatOpen && (
        <div
          ref={chatPanelRef}
          className="fixed inset-y-0 left-[56px] z-50 border-r border-gray-200 bg-white shadow-xl"
          style={{
            width: `${chatWidth}px`,
            maxWidth: `calc(100vw - 56px)`,
          }}
        >
          <ChatPanel onClose={closeChat} />

          {/* Resize handle (right edge) */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat panel"
            onPointerDown={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDoubleClick={() => setChatWidth(CHAT_WIDTH_DEFAULT)}
            title="Drag to resize · double-click to reset"
            className="group absolute inset-y-0 right-0 flex w-1.5 cursor-ew-resize items-center justify-center hover:bg-blue-100"
            style={{
              backgroundColor: isDragging ? "#bfdbfe" : undefined,
            }}
          >
            <div
              className="h-10 w-0.5 rounded-full transition-colors group-hover:bg-blue-400"
              style={{
                backgroundColor: isDragging ? "#2563eb" : "transparent",
              }}
            />
          </div>
        </div>
      )}

      {/* Chat button — floating at bottom of sidebar, above settings */}
      <button
        ref={chatButtonRef}
        type="button"
        onClick={() => setChatOpen(!chatOpen)}
        title={unreadCount > 0 ? `Swarm Chat · ${unreadCount} unread` : "Swarm Chat"}
        className="fixed bottom-[60px] left-[8px] z-40 flex h-[39.99px] w-[39.99px] items-center justify-center rounded-full shadow-md transition-all hover:scale-105"
        style={{
          backgroundColor: chatOpen ? "#2563eb" : "#eff6ff",
          color: chatOpen ? "#FFFFFF" : "#2563eb",
          border: chatOpen ? "2px solid #2563eb" : "2px solid #bfdbfe",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
        {/* Unread badge */}
        {unreadCount > 0 && !chatOpen && (
          <span
            className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-white bg-red-500 px-1 text-[10px] font-bold leading-none text-white"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      <ConnectSidebar
        id="sidebar"
        onClick={() => setSelectedDrive(undefined)}
        onClickSettings={onClickSettings}
        onInspectorClick={inspectorEnabled ? onInspectorClick : undefined}
        address={user?.address}
        onLogin={openRenown}
        onDisconnect={logout}
        ensName={ensName || ensInfo.data?.ens}
        avatarUrl={
          avatarUrl ||
          ensInfo.data?.avatar_small ||
          ensInfo.data?.avatar_url ||
          undefined
        }
        etherscanUrl={etherscanUrl}
        showDebug={connectDebug}
        onDebugClick={onDebugClick}
      >
        <ErrorBoundary
          variant="text"
          fallbackMessage="There was an error loading drives"
          loggerContext={["Connect", "Sidebar"]}
        >
          {drives?.map((drive, index) => (
            <SidebarItem
              key={index}
              title={drive.header.name}
              onClick={() => setSelectedDrive(drive)}
              active={selectedDrive?.header.id === drive.header.id}
              icon={<DriveIcon drive={drive} />}
            />
          ))}
          {connectConfig.drives.addDriveEnabled && (
            <SidebarAddDriveItem onClick={onAddDriveClick} />
          )}
        </ErrorBoundary>
      </ConnectSidebar>
    </ConnectTooltipProvider>
  );
}
