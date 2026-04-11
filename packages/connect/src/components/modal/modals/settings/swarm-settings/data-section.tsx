import React, { useState } from "react";
import type { SwarmUiSnapshot } from "./types.js";
import { ActionButton, Section } from "./primitives.js";
import { toast } from "../../../../../services/toast.js";

export function DataManagementSection({
  swarm,
  ready,
  showStatus,
}: {
  swarm: SwarmUiSnapshot;
  ready: boolean;
  showStatus: (ok: boolean, msg: string) => void;
}) {
  const [clearingStorage, setClearingStorage] = useState(false);
  const [clearStep, setClearStep] = useState<string | null>(null);

  return (
    <Section title="Swarm Data">
      <p className="mb-2 text-xs text-gray-400">
        Clear all documents and manifests from Swarm feeds. This writes empty manifests &mdash;
        old data expires when the stamp runs out. Use this to start fresh if feeds have stale
        data.
      </p>
      {swarm.hydrating && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-yellow-200 bg-yellow-50 p-2">
          <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-yellow-500 border-t-transparent" />
          <span className="text-[10px] font-medium text-yellow-700">
            Restoration in progress — actions are disabled until hydration completes.
          </span>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-500">Clear all Swarm data</span>
        <ActionButton
          onClick={async () => {
            setClearingStorage(true);
            try {
              if (swarm?.clearStorage) {
                setClearStep("Writing empty manifests to feeds...");
                toast("Clearing Swarm storage...", { type: "connect-success" });
                await swarm.clearStorage();
                setClearStep("Done! Sync will resume automatically.");
                toast("Swarm storage cleared", { type: "connect-success" });
                showStatus(true, "Swarm storage cleared. Sync will resume automatically.");
              } else {
                // Fallback: call client API directly
                setClearStep("Clearing via client API...");
                const ph = (window as any).ph as
                  | { swarm?: SwarmUiSnapshot; renown?: { user?: { address?: string } } }
                  | undefined;
                const client = ph?.swarm?.client as
                  | { updateUserManifest?: (address: string, manifest: unknown) => Promise<void> }
                  | undefined;
                const address = ph?.renown?.user?.address;
                if (client?.updateUserManifest && address) {
                  await client.updateUserManifest(address, {
                    address,
                    documents: {},
                    drives: {},
                    stamps: {},
                    updatedAt: new Date().toISOString(),
                  });
                  toast("Swarm storage cleared", { type: "connect-success" });
                  showStatus(true, "Swarm storage cleared. Refresh to start fresh.");
                } else {
                  toast("Cannot clear \u2014 Swarm client not available", { type: "connect-warning" });
                  showStatus(false, "Cannot clear \u2014 Swarm client not available.");
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Clear failed";
              toast(msg, { type: "connect-warning" });
              showStatus(false, msg);
            } finally {
              setClearingStorage(false);
              setClearStep(null);
            }
          }}
          loading={clearingStorage}
          disabled={!ready || !!swarm.hydrating}
        >
          {clearingStorage ? "Clearing..." : "Clear Swarm Storage"}
        </ActionButton>
      </div>
      {clearStep && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-2">
          <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          <span className="text-[10px] font-medium text-blue-700">{clearStep}</span>
        </div>
      )}
    </Section>
  );
}

export function CacheSection({
  swarm,
  ready,
}: {
  swarm: SwarmUiSnapshot;
  ready: boolean;
}) {
  const [clearing, setClearing] = useState(false);
  const [clearStep, setClearStep] = useState<string | null>(null);

  const handleClearCache = async () => {
    if (!swarm.plugin?.clearCache) return;
    setClearing(true);
    try {
      setClearStep("Clearing cached Swarm key...");
      toast("Clearing Swarm key cache...", { type: "connect-success" });
      await swarm.plugin.clearCache();

      setClearStep("Reconnecting with fresh key...");
      if (swarm.reconnect) await swarm.reconnect();

      toast("Swarm key cleared and reconnected", { type: "connect-success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Clear cache failed", {
        type: "connect-warning",
      });
    } finally {
      setClearing(false);
      setClearStep(null);
    }
  };

  return (
    <Section title="Swarm Key Cache">
      <p className="mb-2 text-xs text-gray-400">
        Your Swarm key is derived from a one-time wallet signature and cached locally in
        IndexedDB. Clearing it will prompt a new signature from your wallet and automatically
        reconnect &mdash; your Swarm data is not lost since the same wallet always produces the
        same key.
      </p>
      {swarm.hydrating && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-yellow-200 bg-yellow-50 p-2">
          <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-yellow-500 border-t-transparent" />
          <span className="text-[10px] font-medium text-yellow-700">
            Restoration in progress — wait for hydration to complete.
          </span>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-500">Clear and reconnect</span>
        <ActionButton onClick={handleClearCache} loading={clearing} disabled={!ready || !!swarm.hydrating}>
          {clearing ? "Reconnecting..." : "Clear & Reconnect"}
        </ActionButton>
      </div>
      {clearStep && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-2">
          <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          <span className="text-[10px] font-medium text-blue-700">{clearStep}</span>
        </div>
      )}
    </Section>
  );
}
