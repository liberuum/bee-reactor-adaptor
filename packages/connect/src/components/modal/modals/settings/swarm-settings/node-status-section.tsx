import React, { useCallback, useEffect, useState } from "react";
import type { NodeStatus, SwarmUiSnapshot } from "./types.js";
import { Row, Section, StatusDot } from "./primitives.js";
import { toast } from "../../../../../services/toast.js";

export function NodeStatusSection({ swarm }: { swarm: SwarmUiSnapshot }) {
  const [nodeStatus, setNodeStatus] = useState<NodeStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const [manualRefresh, setManualRefresh] = useState(false);

  const fetchStatus = useCallback(async (manual = false) => {
    if (!swarm.getNodeStatus) return;
    setLoading(true);
    try {
      const status = await swarm.getNodeStatus();
      setNodeStatus(status);
      if (manual) toast("Node status refreshed", { type: "connect-success" });
    } catch {
      setNodeStatus(null);
      if (manual) toast("Failed to fetch node status", { type: "connect-warning" });
    } finally {
      setLoading(false);
    }
  }, [swarm.getNodeStatus]);

  // Fetch on mount and every 30s
  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 30_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  if (!nodeStatus && !loading) return null;

  const modeColor =
    nodeStatus?.beeMode === "full"
      ? "#22c55e"
      : nodeStatus?.beeMode === "light" || nodeStatus?.beeMode === "ultra-light"
        ? "#eab308"
        : nodeStatus?.beeMode === "dev"
          ? "#3b82f6"
          : "#9ca3af";

  const modeLabel =
    nodeStatus?.beeMode === "full"
      ? "Full Node"
      : nodeStatus?.beeMode === "light"
        ? "Light Node"
        : nodeStatus?.beeMode === "ultra-light"
          ? "Ultra-Light"
          : nodeStatus?.beeMode === "dev"
            ? "Dev Mode"
            : "Unknown";

  return (
    <Section
      title={
        <div className="flex w-full items-center justify-between">
          <span>Bee Node</span>
          <button
            type="button"
            onClick={() => fetchStatus(true)}
            disabled={loading}
            className="text-[10px] text-blue-500 hover:text-blue-700 disabled:text-gray-400"
          >
            {loading ? "refreshing..." : "refresh"}
          </button>
        </div>
      }
    >
      {loading && !nodeStatus ? (
        <div className="flex items-center gap-2 py-2">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
          <span className="text-xs text-gray-400">Loading node status...</span>
        </div>
      ) : nodeStatus ? (
        <>
          <Row
            label="Mode"
            value={
              <span className="flex items-center gap-1.5">
                <StatusDot color={modeColor} />
                <span className="font-medium">{modeLabel}</span>
              </span>
            }
          />
          <Row
            label="Reachable"
            value={
              <span className="flex items-center gap-1.5">
                <StatusDot color={nodeStatus.isReachable ? "#22c55e" : "#ef4444"} />
                {nodeStatus.isReachable ? "Yes" : "No (NAT/firewall)"}
              </span>
            }
          />
          <Row label="Connected Peers" value={String(nodeStatus.connectedPeers)} />
          <Row
            label={
              <span className="group relative cursor-help">
                Neighborhood
                <span className="pointer-events-none absolute bottom-full left-0 z-10 mb-1 hidden w-56 rounded bg-gray-800 p-2 text-[10px] font-normal leading-relaxed text-white shadow-lg group-hover:block">
                  Number of peers in your storage neighborhood. Higher = better data
                  redundancy and faster retrieval.
                </span>
              </span>
            }
            value={String(nodeStatus.neighborhoodSize)}
          />
          <Row
            label={
              <span className="group relative cursor-help">
                Storage Radius
                <span className="pointer-events-none absolute bottom-full left-0 z-10 mb-1 hidden w-56 rounded bg-gray-800 p-2 text-[10px] font-normal leading-relaxed text-white shadow-lg group-hover:block">
                  The radius of content your node is responsible for storing. Higher = more
                  network responsibility.
                </span>
              </span>
            }
            value={String(nodeStatus.storageRadius)}
          />
          {nodeStatus.pullsyncRate > 0 && (
            <Row label="Pull Sync Rate" value={`${nodeStatus.pullsyncRate} chunks/s`} />
          )}
          {nodeStatus.reserveSize > 0 && (
            <Row
              label="Reserve"
              value={`${(nodeStatus.reserveSize / 1024 / 1024).toFixed(1)} MB`}
            />
          )}
          {!nodeStatus.isReachable && (
            <p className="mt-2 text-[10px] text-yellow-600">
              Your node is not reachable from the network. Other nodes cannot push data to you.
              Check your firewall/NAT settings or enable UPnP.
            </p>
          )}
          {nodeStatus.beeMode === "light" && (
            <p className="mt-2 text-[10px] text-yellow-600">
              Light nodes don&apos;t store data for the network. Consider running a full node
              for better upload confirmation and data availability.
            </p>
          )}
        </>
      ) : null}
    </Section>
  );
}
