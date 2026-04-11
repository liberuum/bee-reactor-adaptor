import { Icon } from "@powerhousedao/design-system";
import { SettingsModal as SettingsModalV2 } from "@powerhousedao/design-system/connect";
import { closePHModal, usePHModal } from "@powerhousedao/reactor-browser";
import { t } from "i18next";
import React, { useMemo } from "react";
import { About } from "./settings/about.js";
import { DangerZone } from "./settings/danger-zone.js";
import { DefaultEditor } from "./settings/default-editor.js";
import { ConnectPackageManager } from "./settings/package-manager.js";
import { SwarmStorageSettings } from "./settings/swarm-settings/index.js";

/** Ethswarm logo mark — simplified for use as a 12-16px settings tab icon. */
function SwarmIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1320 1342"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <polygon opacity="0.45" points="1125.21 136.97 1125.21 293.82 985.79 215.4 985.79 58.54" />
      <polygon opacity="0.6" points="985.79 215.4 985.79 372.25 1125.21 293.82 1125.21 136.97" />
      <polygon opacity="0.3" points="67.5 1092.22 346.35 1249.07 625.21 1092.22 346.35 935.36" />
      <polygon opacity="0.45" points="346.35 935.36 346.35 1249.07 67.5 1092.22 67.5 778.51" />
      <polygon opacity="0.45" points="625.21 778.51 625.21 1092.22 346.35 935.36 346.35 621.65" />
      <polygon opacity="0.6" points="346.35 935.36 346.35 1249.07 625.21 1092.22 625.21 778.51" />
      <polygon opacity="0.6" points="67.5 778.51 67.5 1092.22 346.35 935.36 346.35 621.65" />
      <polygon opacity="0.8" points="654.65 407.11 794.08 485.53 933.5 407.11 794.08 328.68" />
      <polygon opacity="0.8" points="67.5 778.51 346.35 935.36 625.21 778.51 346.35 621.65" />
      <polygon opacity="0.3" points="691.46 1092.22 970.31 1249.07 1249.16 1092.22 970.31 935.36" />
      <polygon opacity="0.45" points="970.31 935.36 970.31 1249.07 691.46 1092.22 691.46 778.51" />
      <polygon opacity="0.45" points="1249.16 778.51 1249.16 1092.22 970.31 935.36 970.31 621.65" />
      <polygon opacity="0.6" points="970.31 935.36 970.31 1249.07 1249.16 1092.22 1249.16 778.51" />
      <polygon opacity="0.6" points="691.46 778.51 691.46 1092.22 970.31 935.36 970.31 621.65" />
      <polygon opacity="0.8" points="691.46 778.51 970.31 935.36 1249.16 778.51 970.31 621.65" />
      <polygon opacity="0.6" points="654.65 250.25 654.65 407.11 794.08 328.68 794.08 171.82" />
      <polygon opacity="0.3" points="375.8 563.96 654.65 720.81 933.5 563.96 654.65 407.11" />
      <polygon opacity="0.45" points="654.65 407.11 654.65 720.81 375.8 563.96 375.8 250.25" />
      <polygon opacity="0.6" points="375.8 250.25 375.8 563.96 654.65 407.11 654.65 93.4" />
      <polygon opacity="0.6" points="794.08 485.53 794.08 328.68 654.65 407.11 654.65 563.96 654.65 720.81 794.08 642.39 933.5 563.96 933.5 407.11" />
      <polygon opacity="0.45" points="794.08 171.82 654.65 93.4 654.65 407.11 933.5 563.96 933.5 407.11 794.08 328.68" />
      <polygon opacity="0.8" points="654.65 93.4 794.08 171.82 654.65 250.25 654.65 407.11 375.8 250.25" />
      <polygon opacity="0.8" points="846.36 136.97 985.79 215.4 1125.21 136.97 985.79 58.54" />
    </svg>
  );
}

export const SettingsModal: React.FC = () => {
  const phModal = usePHModal();
  const open = phModal?.type === "settings";
  function onRefresh() {
    window.location.reload();
  }

  const tabs = useMemo(
    () => [
      {
        id: "package-manager",
        icon: <Icon name="PackageManager" size={12} />,
        label: "Package Manager",
        content: ConnectPackageManager,
      },
      {
        id: "default-editors",
        icon: <Icon name="Edit" size={12} />,
        label: "Default Editors",
        content: DefaultEditor,
      },
      {
        id: "swarm-storage",
        icon: <SwarmIcon size={14} />,
        label: "Swarm Storage",
        content: SwarmStorageSettings,
      },
      {
        id: "danger-zone",
        icon: <Icon name="Danger" size={12} className="text-red-900" />,
        label: <span className="text-red-900">Danger Zone</span>,
        content: () => <DangerZone />,
      },
      {
        id: "about",
        icon: <Icon name="QuestionSquare" size={12} />,
        label: "About",
        content: About,
      },
    ],
    [onRefresh],
  );

  return (
    <SettingsModalV2
      open={open}
      title={t("modals.connectSettings.title")}
      onOpenChange={(status: boolean) => {
        if (!status) return closePHModal();
      }}
      tabs={tabs}
    />
  );
};
