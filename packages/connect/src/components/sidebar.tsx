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
      {chatOpen && (
        <div className="fixed inset-y-0 left-[240px] z-50 w-[340px] border-r border-gray-200 bg-white shadow-lg">
          <ChatPanel onClose={() => setChatOpen(false)} />
        </div>
      )}
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
        <button
          type="button"
          onClick={() => setChatOpen(!chatOpen)}
          className={`mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm ${
            chatOpen ? "bg-blue-50 text-blue-600" : "text-gray-600 hover:bg-gray-50"
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
          <span>Chat</span>
        </button>
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
