import React, { useCallback, useEffect, useState } from "react";
import type { BeeStampInfo, SwarmUiSnapshot } from "./types.js";
import { ActionButton, Section, StatusDot } from "./primitives.js";
import { formatBytes } from "./constants.js";
import { toast } from "../../../../../services/toast.js";

function formatTtl(seconds: number): string {
  if (seconds <= 0) return "expired";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${Math.floor(seconds / 60)}m`;
}

function stampCapacity(depth: number): string {
  const sizes: Record<number, string> = {
    17: "4 MB", 18: "32 MB", 19: "110 MB", 20: "680 MB",
    21: "2.6 GB", 22: "7.7 GB", 23: "20 GB", 24: "47 GB",
    25: "105 GB", 26: "227 GB", 27: "476 GB",
  };
  return sizes[depth] ?? `depth ${depth}`;
}

export function StampPicker({
  swarm,
  currentBatchId,
}: {
  swarm: SwarmUiSnapshot;
  currentBatchId?: string;
}) {
  const [stamps, setStamps] = useState<BeeStampInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  const fetchStamps = useCallback(async () => {
    if (!swarm.getAllStamps) return;
    setLoading(true);
    try {
      const all = await swarm.getAllStamps();
      // Sort: usable first, then mutable first, then by TTL descending
      all.sort((a, b) => {
        if (a.usable !== b.usable) return a.usable ? -1 : 1;
        if (a.immutableFlag !== b.immutableFlag) return a.immutableFlag ? 1 : -1;
        return b.batchTTL - a.batchTTL;
      });
      setStamps(all);
    } catch {
      setStamps([]);
    } finally {
      setLoading(false);
    }
  }, [swarm.getAllStamps]);

  useEffect(() => {
    fetchStamps();
  }, [fetchStamps]);

  // Auto-poll every 15s while any stamp is pending blockchain confirmation
  const pendingIds = stamps.filter((s) => !s.usable && s.batchTTL > 0).map((s) => s.batchID);
  const prevPendingRef = React.useRef<string[]>([]);
  useEffect(() => {
    if (pendingIds.length === 0) return;
    const id = setInterval(async () => {
      if (!swarm.getAllStamps) return;
      try {
        const fresh = await swarm.getAllStamps();
        // Check if any previously pending stamp just became usable
        for (const pid of prevPendingRef.current) {
          const now = fresh.find((s) => s.batchID === pid);
          if (now?.usable) {
            const label = now.immutableFlag ? "immutable" : "mutable";
            toast(`Stamp ${pid.slice(0, 8)}... is now usable (${label})`, { type: "connect-success" });
          }
        }
        prevPendingRef.current = fresh.filter((s) => !s.usable && s.batchTTL > 0).map((s) => s.batchID);
        // Update the list
        fresh.sort((a, b) => {
          if (a.usable !== b.usable) return a.usable ? -1 : 1;
          if (a.immutableFlag !== b.immutableFlag) return a.immutableFlag ? 1 : -1;
          return b.batchTTL - a.batchTTL;
        });
        setStamps(fresh);
      } catch {}
    }, 15_000);
    return () => clearInterval(id);
  }, [pendingIds.length, swarm.getAllStamps]);
  useEffect(() => {
    prevPendingRef.current = pendingIds;
  }, [pendingIds.join(",")]);

  const [switchStep, setSwitchStep] = useState<string | null>(null);

  const handleSwitch = async (batchId: string) => {
    if (!swarm.switchStamp) return;
    setSwitching(batchId);
    try {
      setSwitchStep("Saving stamp preference...");
      toast("Switching stamp...", { type: "connect-success" });

      setSwitchStep("Reconnecting with new stamp...");
      await swarm.switchStamp(batchId);

      setSwitchStep("Done!");
      toast(`Switched to stamp ${batchId.slice(0, 8)}...`, { type: "connect-success" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Switch failed";
      toast(msg, { type: "connect-warning" });
    } finally {
      setSwitching(null);
      setSwitchStep(null);
    }
  };

  if (!swarm.getAllStamps) return null;

  return (
    <Section
      title={
        <div className="flex w-full items-center justify-between">
          <span>All Stamps ({stamps.length})</span>
          <button
            type="button"
            onClick={fetchStamps}
            disabled={loading}
            className="text-[10px] text-blue-500 hover:text-blue-700 disabled:text-gray-400"
          >
            {loading ? "loading..." : "refresh"}
          </button>
        </div>
      }
    >
      {loading && stamps.length === 0 ? (
        <div className="flex items-center gap-2 py-2">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
          <span className="text-xs text-gray-400">Loading stamps...</span>
        </div>
      ) : stamps.length === 0 ? (
        <p className="text-xs text-gray-400">No stamps found on this Bee node.</p>
      ) : (
        <div className="space-y-2">
          {stamps.map((s) => {
            const isCurrent = s.batchID === currentBatchId;
            const ttlColor =
              s.batchTTL <= 0
                ? "text-red-500"
                : s.batchTTL < 86400
                  ? "text-red-500"
                  : s.batchTTL < 604800
                    ? "text-yellow-600"
                    : "text-green-600";

            return (
              <div
                key={s.batchID}
                className={`rounded-lg border p-2.5 transition-colors ${
                  isCurrent
                    ? "border-blue-300 bg-blue-50"
                    : s.usable
                      ? "border-gray-200 bg-white hover:border-gray-300"
                      : "border-gray-100 bg-gray-50 opacity-60"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                          s.immutableFlag
                            ? "bg-yellow-50 text-yellow-700 ring-1 ring-yellow-200"
                            : "bg-green-50 text-green-700 ring-1 ring-green-200"
                        }`}
                      >
                        {s.immutableFlag ? "Immutable" : "Mutable"}
                      </span>
                      <span className="text-[10px] text-gray-500">
                        {stampCapacity(s.depth)}
                      </span>
                      <span className={`text-[10px] font-medium ${ttlColor}`}>
                        {formatTtl(s.batchTTL)}
                      </span>
                      {isCurrent && (
                        <span className="inline-flex items-center rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-medium text-blue-700">
                          Active
                        </span>
                      )}
                      {!s.usable && s.batchTTL > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-medium text-blue-700">
                          <span className="inline-block h-2 w-2 animate-spin rounded-full border border-blue-500 border-t-transparent" />
                          Pending
                        </span>
                      )}
                      {!s.usable && s.batchTTL <= 0 && (
                        <span className="inline-flex items-center rounded-full bg-red-100 px-1.5 py-0.5 text-[9px] font-medium text-red-700">
                          Expired
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-gray-400">
                      <span className="font-mono">{s.batchID.slice(0, 16)}...</span>
                      <span>Util: {Math.round((s.utilization / Math.pow(2, s.depth - s.bucketDepth)) * 100)}%</span>
                    </div>
                  </div>
                  {s.usable && !isCurrent && (
                    <ActionButton
                      onClick={() => handleSwitch(s.batchID)}
                      loading={switching === s.batchID}
                      disabled={!!switching}
                      variant="primary"
                    >
                      Use
                    </ActionButton>
                  )}
                  {!s.usable && s.batchTTL > 0 && (
                    <span className="text-[9px] text-blue-500 shrink-0">
                      confirming...
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {switchStep && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-2">
          <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          <span className="text-[10px] font-medium text-blue-700">{switchStep}</span>
        </div>
      )}
    </Section>
  );
}
