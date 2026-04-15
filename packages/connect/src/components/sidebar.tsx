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
import { useState } from "react";
import { ErrorBoundary } from "./error-boundary.js";
import { ChatPanel } from "./chat/index.js";

export function Sidebar() {
  const user = useUser();
  const drives = useDrives();
  const [selectedDrive] = useSelectedDriveSafe();
  const inspectorEnabled = useInspectorEnabled();
  const connectDebug = localStorage.getItem("CONNECT_DEBUG") === "true";
  const [chatOpen, setChatOpen] = useState(false);

  const ensName = user?.ens?.name || user?.profile?.username || undefined;
  const avatarUrl =
    user?.ens?.avatarUrl || user?.profile?.userImage || undefined;

  const ensInfo = useEns(!avatarUrl ? user?.address : undefined);

  const onClickSettings = () => {
    showPHModal({ type: "settings" });
  };

  const onAddDriveClick = () => {
    showPHModal({ type: "addDrive" });
  };

  const onInspectorClick = () => {
    showPHModal({ type: "inspector" });
  };

  const etherscanUrl = user?.address
    ? `https://etherscan.io/address/${user.address}`
    : "";

  return (
    <ConnectTooltipProvider>
      {/* Chat panel — slides out from sidebar */}
      {chatOpen && (
        <div className="fixed inset-y-0 left-[240px] z-50 w-[360px] border-r border-orange-200 bg-white shadow-xl">
          <ChatPanel onClose={() => setChatOpen(false)} />
        </div>
      )}

      {/* Chat button — floating at bottom of sidebar, above settings */}
      <button
        type="button"
        onClick={() => setChatOpen(!chatOpen)}
        title="Swarm Chat"
        className="fixed bottom-[60px] left-[12px] z-40 flex h-9 w-9 items-center justify-center rounded-full shadow-md transition-all hover:scale-105"
        style={{
          backgroundColor: chatOpen ? "#F7931A" : "#FFF7ED",
          color: chatOpen ? "#FFFFFF" : "#F7931A",
          border: chatOpen ? "2px solid #F7931A" : "2px solid #FED7AA",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
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
        onDebugClick={() => showPHModal({ type: "debugSettings" })}
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
