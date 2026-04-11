import { Icon } from "@powerhousedao/design-system";
import React, { useEffect, useRef, useState } from "react";
import type { SwarmUiSnapshot, StampOptions } from "./types.js";
import { AlertBanner, CopyableValue, Section } from "./primitives.js";
import { normalizeAddr } from "./constants.js";
import { DocsTreeSection } from "./documents.js";
import { ShareSection, ImportSection } from "./sharing.js";
import { StorageSection, CreateStampSection } from "./storage-section.js";
import { ConnectionSection, WalletSection } from "./connection-section.js";
import { DataManagementSection, CacheSection } from "./data-section.js";
import { NodeStatusSection } from "./node-status-section.js";
import { StampPicker } from "./stamp-picker.js";

export type { SwarmUiSnapshot } from "./types.js";

/**
 * Swarm Storage settings panel.
 *
 * Progressive disclosure:
 *  - Plugin not loaded → "Swarm plugin not active"
 *  - Plugin loaded but disconnected → Connection section + error + setup help
 *  - Connected but no stamp → Connection + Wallet + Create Stamp
 *  - Fully ready → All sections
 *
 * Auto-expands the parent settings dialog on mount so the Swarm tab
 * has room for all its sections. Restores the original size on unmount.
 */
export const SwarmStorageSettings: React.FC = () => {
  const [swarm, setSwarm] = useState<SwarmUiSnapshot | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const [stampOptions, setStampOptions] = useState<StampOptions | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Auto-expand the settings modal when Swarm tab is active ───
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const dialog = el.closest('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) return;

    const prev = {
      maxWidth: dialog.style.maxWidth,
      width: dialog.style.width,
      transition: dialog.style.transition,
    };

    dialog.style.transition =
      "max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1), width 0.3s cubic-bezier(0.4, 0, 0.2, 1)";
    requestAnimationFrame(() => {
      dialog.style.maxWidth = "72rem";
      dialog.style.width = "95vw";
    });

    return () => {
      dialog.style.maxWidth = prev.maxWidth;
      dialog.style.width = prev.width;
      const timerId = setTimeout(() => {
        dialog.style.transition = prev.transition;
      }, 350);
      return () => clearTimeout(timerId);
    };
  }, []);

  // ── Poll window.ph.swarm every 2s ────────────────────────────
  useEffect(() => {
    const read = () => {
      const ph = (window as any).ph as { swarm?: SwarmUiSnapshot } | undefined;
      const s = ph?.swarm;
      if (!s) {
        setSwarm(null);
        return;
      }
      const um = s.userManifest;
      setSwarm({
        ...s,
        userManifest: um
          ? {
              documents: { ...um.documents },
              driveManifests: um.driveManifests ? { ...um.driveManifests } : undefined,
            }
          : undefined,
      });
    };
    read();
    const id = setInterval(read, 2000);
    return () => clearInterval(id);
  }, []);

  // Toast subscriptions for Swarm events live at the app level (reactor.ts)
  // so they fire even when this settings panel is closed.

  // ── Load stamp options when client is ready ──────────────────
  useEffect(() => {
    const client = swarm?.client;
    if (!client?.getStampOptions) return;
    client.getStampOptions().then(setStampOptions).catch(() => {});
  }, [swarm?.client, swarm?.ready]);

  const showStatus = (ok: boolean, msg: string) => {
    setStatusMsg({ ok, msg });
    setTimeout(() => setStatusMsg(null), 6000);
  };

  // ── Plugin not loaded at all ─────────────────────────────────

  if (!swarm) {
    return (
      <div
        ref={containerRef}
        className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-gray-400"
      >
        <Icon name="Globe" size={32} />
        <p className="text-sm">Swarm plugin not active</p>
        <p className="text-xs">
          SwarmConnectPlugin must be started before using Swarm storage.
        </p>
      </div>
    );
  }

  // ── Derive connection state ──────────────────────────────────

  const status = swarm.status ?? (swarm.ready ? "ready" : "disconnected");
  const isConnected = status === "ready" || status === "no-stamp";
  const isReady = status === "ready" && !!swarm.ready;
  const stamp = swarm.stampStatus;
  const docs = swarm.userManifest ? Object.entries(swarm.userManifest.documents) : [];

  const needsAttention =
    stamp &&
    (stamp.health === "warning" || stamp.health === "critical" || stamp.health === "expired");
  const capacityHigh = stamp && stamp.utilization > 80;

  return (
    <div
      ref={containerRef}
      className="overflow-y-auto p-4"
      style={{ maxHeight: "calc(85vh - 100px)" }}
    >
      <div className="flex flex-col gap-1">
        {/* ── Status alerts ── */}
        {statusMsg && (
          <AlertBanner type={statusMsg.ok ? "info" : "critical"}>
            <p>{statusMsg.msg}</p>
          </AlertBanner>
        )}

        {/* ── Connection + Node Status — ALWAYS visible when plugin loaded ── */}
        <ConnectionSection swarm={swarm} />
        {isConnected && <NodeStatusSection swarm={swarm} />}

        {/* ── Not connected: show clear notification + setup help ── */}
        {status === "initializing" && (
          <div className="flex items-center justify-center gap-3 rounded-lg border border-blue-100 bg-blue-50 p-6">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
            <div>
              <p className="text-sm font-medium text-blue-700">
                Connecting to Bee node...
              </p>
              {swarm.statusMessage && (
                <p className="text-xs text-blue-500 mt-0.5">{swarm.statusMessage}</p>
              )}
            </div>
          </div>
        )}

        {status === "disconnected" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 shrink-0 rounded-full bg-red-100 p-1.5">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  className="text-red-500"
                >
                  <path
                    d="M8 5v3m0 3h.01M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-red-800">
                  Bee node not reachable
                </p>
                <p className="mt-1 text-xs text-red-600">
                  {swarm.statusMessage ||
                    "Cannot connect to the Bee node. Check that it is running and the URL above is correct."}
                </p>
                <div className="mt-3 rounded-md bg-white/60 p-3 text-xs text-red-700">
                  <p className="font-medium mb-1.5">How to fix:</p>
                  <ol className="list-decimal list-inside space-y-1">
                    <li>
                      Verify your Bee node is running (
                      <a
                        href="https://docs.ethswarm.org/docs/bee/installation/quick-start"
                        target="_blank"
                        rel="noopener"
                        className="font-medium text-blue-600 hover:underline"
                      >
                        installation guide
                      </a>
                      )
                    </li>
                    <li>Check the Bee node URL above is correct (default: http://localhost:1633)</li>
                    <li>Ensure your firewall allows connections to the Bee API port</li>
                    <li>If using HTTPS, verify the TLS certificate is valid</li>
                  </ol>
                </div>
              </div>
            </div>
          </div>
        )}

        {status === "no-stamp" && (
          <>
            <AlertBanner type="warning">
              <p className="font-medium">
                Bee node connected but no usable postage stamp found.
              </p>
              <p className="mt-1 text-xs">
                Fund your Bee node wallet below, then create a postage stamp to start
                storing data on Swarm.
              </p>
            </AlertBanner>

            {/* Show wallet + create stamp when no stamp */}
            {swarm.nodeWallet && (
              <WalletSection
                nodeWallet={swarm.nodeWallet}
                balances={swarm.nodeBalances}
                ready={isConnected}
                showStatus={showStatus}
              />
            )}
            <CreateStampSection
              client={swarm.client}
              ready={isConnected}
              stampOptions={stampOptions}
              showStatus={showStatus}
              nodeBalanceBzz={swarm.nodeBalances?.xBZZ}
              reconnect={swarm.reconnect}
            />
          </>
        )}

        {/* ── Remaining sections — only when fully ready ── */}
        {isReady && (
          <>
            {needsAttention && stamp && (
              <AlertBanner
                type={
                  stamp.health === "critical" || stamp.health === "expired"
                    ? "critical"
                    : "warning"
                }
              >
                <p className="font-medium">
                  {stamp.health === "expired"
                    ? "Stamp expired \u2014 uploads are disabled! Top up using the controls below."
                    : stamp.health === "critical"
                      ? `Stamp expires in ${stamp.ttlHuman}! Top up below to keep your data available.`
                      : `Stamp expires in ${stamp.ttlHuman}. Consider topping up below.`}
                </p>
              </AlertBanner>
            )}
            {capacityHigh && stamp && (
              <AlertBanner type={stamp.utilization >= 100 ? "critical" : "warning"}>
                <p className="font-medium">
                  {stamp.utilization >= 100
                    ? "Storage full \u2014 new uploads will fail! Expand capacity below."
                    : `Storage ${stamp.utilization}% full. Expand capacity below or uploads may fail.`}
                </p>
              </AlertBanner>
            )}

            {swarm.nodeWallet && (
              <WalletSection
                nodeWallet={swarm.nodeWallet}
                balances={swarm.nodeBalances}
                ready={isReady}
                showStatus={showStatus}
              />
            )}

            {stamp ? (
              <StorageSection
                stamp={stamp}
                client={swarm.client}
                isDevMode={swarm.isDevMode}
                ready={isReady}
                stampOptions={stampOptions}
                totalBytesUploaded={swarm.totalBytesUploaded}
                showStatus={showStatus}
                getBucketUtilization={swarm.getBucketUtilization}
                nodeBalanceBzz={swarm.nodeBalances?.xBZZ}
                reconnect={swarm.reconnect}
                refreshStamp={swarm.refreshStamp}
              />
            ) : (
              <CreateStampSection
                client={swarm.client}
                ready={isReady}
                stampOptions={stampOptions}
                showStatus={showStatus}
                nodeBalanceBzz={swarm.nodeBalances?.xBZZ}
                reconnect={swarm.reconnect}
              />
            )}

            <StampPicker swarm={swarm} currentBatchId={stamp?.batchId} />

            <DocsTreeSection
              docs={docs}
              syncStatus={swarm.syncStatus}
              driveManifests={swarm.userManifest?.driveManifests}
              isContentAvailable={swarm.isContentAvailable}
              reuploadContent={swarm.reuploadContent}
            />

            {swarm.signerEntry?.ownerAddress && (
              <Section title="Your Swarm ID">
                <p className="mb-1 text-xs text-gray-400">
                  Share this ID with others so they can send you documents via Swarm.
                </p>
                <CopyableValue
                  value={normalizeAddr(
                    swarm.client
                      ? ((swarm.client as any).getOwnerAddress?.() ??
                          swarm.signerEntry.ownerAddress)
                      : swarm.signerEntry.ownerAddress,
                  )}
                />
              </Section>
            )}

            <ShareSection swarm={swarm} docs={docs} ready={isReady} />
            <ImportSection swarm={swarm} ready={isReady} />
            <DataManagementSection swarm={swarm} ready={isReady} showStatus={showStatus} />
            <CacheSection swarm={swarm} ready={isReady} />
          </>
        )}
      </div>
    </div>
  );
};
