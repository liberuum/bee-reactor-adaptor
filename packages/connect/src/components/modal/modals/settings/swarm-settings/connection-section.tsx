import React, { useEffect, useState } from "react";
import type { SwarmUiSnapshot } from "./types.js";
import { ActionButton, CopyableValue, Row, Section, StatusDot } from "./primitives.js";
import { formatBZZ, formatDAI, sendXBZZ, sendXDAI } from "./constants.js";
import { toast } from "../../../../../services/toast.js";

export function ConnectionSection({ swarm }: { swarm: SwarmUiSnapshot }) {
  const currentBeeUrl = swarm.beeUrl || "http://localhost:1633";
  const [beeUrlInput, setBeeUrlInput] = useState(currentBeeUrl);
  const [savingBeeUrl, setSavingBeeUrl] = useState(false);

  // Sync input when the plugin's URL changes externally
  useEffect(() => {
    if (swarm.beeUrl && swarm.beeUrl !== beeUrlInput) {
      setBeeUrlInput(swarm.beeUrl);
    }
  }, [swarm.beeUrl]);

  const beeUrlChanged = beeUrlInput.trim().replace(/\/+$/, "") !== currentBeeUrl;

  const handleSaveUrl = async () => {
    if (!swarm.setBeeUrl) return;
    const cleaned = beeUrlInput.trim().replace(/\/+$/, "");
    setSavingBeeUrl(true);
    try {
      await swarm.setBeeUrl(cleaned);
      // No toast here — the app-level plugin:ready event fires the
      // "Connected to Swarm" toast when the connection actually succeeds.
      // The status indicator in this section shows "Connecting..." in the meantime.
    } catch (err) {
      toast(err instanceof Error ? err.message : "Connection failed", { type: "connect-warning" });
    } finally {
      setSavingBeeUrl(false);
    }
  };

  return (
    <Section title="Connection">
      <div className="mb-2">
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 shrink-0">Bee Node</label>
          <input
            type="text"
            value={beeUrlInput}
            placeholder="https://your-bee-node.com:1633"
            onChange={(e) => setBeeUrlInput(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Enter" && beeUrlChanged) await handleSaveUrl();
            }}
            className={`flex-1 rounded-md border px-2 py-1 text-xs font-mono ${
              beeUrlChanged ? "border-blue-400" : "border-gray-200"
            }`}
          />
          {beeUrlChanged && (
            <ActionButton onClick={handleSaveUrl} loading={savingBeeUrl} variant="primary">
              {savingBeeUrl ? "Connecting..." : "Save & Connect"}
            </ActionButton>
          )}
        </div>
        <p className="text-[10px] text-gray-400 mt-1">
          Currently connected to: <span className="font-mono">{currentBeeUrl}</span>
        </p>
      </div>
      <Row
        label="Status"
        value={
          <span className="flex items-center gap-1.5">
            <StatusDot color={swarm.ready ? "#22c55e" : swarm.status === "initializing" ? "#3b82f6" : "#ef4444"} />
            <span className={swarm.ready ? "text-green-600 font-medium" : swarm.status === "initializing" ? "text-blue-600" : "text-red-500 font-medium"}>
              {swarm.ready
                ? "Connected"
                : swarm.status === "initializing"
                  ? "Connecting..."
                  : swarm.status === "no-stamp"
                    ? "Connected (no stamp)"
                    : "Disconnected"}
            </span>
          </span>
        }
      />
      {swarm.signerEntry?.ownerAddress && (
        <Row label="Your Wallet" copyable={swarm.signerEntry.ownerAddress} />
      )}
      {swarm.signerEntry?.swarmPublicKey && (
        <Row label="Swarm Key" copyable={swarm.signerEntry.swarmPublicKey} />
      )}
    </Section>
  );
}

export function WalletSection({
  nodeWallet,
  balances,
  ready,
  showStatus,
}: {
  nodeWallet: string;
  balances?: { xBZZ: string; xDAI: string };
  ready: boolean;
  showStatus: (ok: boolean, msg: string) => void;
}) {
  const [fundBusy, setFundBusy] = useState(false);
  const [fundStep, setFundStep] = useState<string | null>(null);
  const hasWallet = !!(window as any).ethereum;

  const handleFundBZZ = async () => {
    setFundBusy(true);
    try {
      setFundStep("Requesting wallet approval...");
      toast("Requesting wallet approval for 1 xBZZ transfer...", { type: "connect-success" });
      const txHash = await sendXBZZ(nodeWallet, "10000000000000000");
      setFundStep("Transaction submitted. Waiting for confirmation...");
      toast(`1 xBZZ sent! Tx: ${txHash.slice(0, 14)}...`, { type: "connect-success" });
      showStatus(true, `Sent 1 xBZZ to Bee node. Tx: ${txHash.slice(0, 14)}...`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "xBZZ transfer failed";
      toast(msg, { type: "connect-warning" });
      showStatus(false, msg);
    } finally {
      setFundBusy(false);
      setFundStep(null);
    }
  };

  const handleFundDAI = async () => {
    setFundBusy(true);
    try {
      setFundStep("Requesting wallet approval...");
      toast("Requesting wallet approval for 0.1 xDAI transfer...", { type: "connect-success" });
      const txHash = await sendXDAI(nodeWallet, "100000000000000000");
      setFundStep("Transaction submitted. Waiting for confirmation...");
      toast(`0.1 xDAI sent! Tx: ${txHash.slice(0, 14)}...`, { type: "connect-success" });
      showStatus(true, `Sent 0.1 xDAI to Bee node. Tx: ${txHash.slice(0, 14)}...`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "xDAI transfer failed";
      toast(msg, { type: "connect-warning" });
      showStatus(false, msg);
    } finally {
      setFundBusy(false);
      setFundStep(null);
    }
  };

  return (
    <Section title="Bee Node Wallet">
      <p className="mb-2 text-xs text-gray-400">
        Your Bee node needs xBZZ (for stamps) and xDAI (for gas) on Gnosis Chain.
      </p>
      <Row label="Node Address" copyable={nodeWallet} />
      {balances && <Row label="xBZZ Balance" value={`${formatBZZ(balances.xBZZ)} xBZZ`} />}
      {balances && <Row label="xDAI Balance" value={`${formatDAI(balances.xDAI)} xDAI`} />}
      {hasWallet ? (
        <div className="mt-2 flex gap-2">
          <ActionButton
            onClick={handleFundBZZ}
            loading={fundBusy}
            disabled={!ready}
            variant="primary"
          >
            {fundBusy ? "Sending..." : "Send 1 xBZZ"}
          </ActionButton>
          <ActionButton onClick={handleFundDAI} loading={fundBusy} disabled={!ready}>
            {fundBusy ? "Sending..." : "Send 0.1 xDAI"}
          </ActionButton>
        </div>
      ) : (
        <p className="mt-2 text-xs text-yellow-600">
          Connect a wallet (MetaMask) to fund the Bee node.
        </p>
      )}
      {fundStep && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-2">
          <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          <span className="text-[10px] font-medium text-blue-700">{fundStep}</span>
        </div>
      )}
    </Section>
  );
}
