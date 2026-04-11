/**
 * Swarm Connect Plugin — Orchestrator
 *
 * Runs in the Connect browser context. Initializes the SwarmConnectPlugin
 * ASYNCHRONOUSLY when the processor factory is registered — does NOT block
 * startup, and does NOT require a drive to exist first.
 *
 * After initialization, delegates to:
 * - hydration.ts  — recovery from Swarm on new device
 * - sync.ts       — real-time operation sync (reactor → Swarm)
 * - flush.ts      — debounced manifest writes
 * - sharing.ts    — public profile and document sharing
 */
import type {
  IProcessorHostModule,
  ProcessorFactoryBuilder,
} from "@powerhousedao/reactor";
import type { PHDocumentHeader } from "document-model";
import type { SwarmClient } from "../swarm-client.js";
import { SwarmConnectPlugin } from "../connect-plugin.js";
import { state, setSwarmStatus, getUploadedBytes, persistBeeUrl, loadDriveMapping } from "./state.js";
import { loadManifestIndex, clearSwarmStorage } from "./flush.js";
import { hydrateFromSwarm, populateUiCacheFromDrives } from "./hydration.js";
import { startOperationSync } from "./sync.js";
import { publishPublicProfile, shareDocumentsWithUser, importFromUser } from "./sharing.js";
import { markPendingOpsExist } from "./pending-ops-store.js";
import { installEventHandlers, emitSwarmEvent } from "./events.js";

const FEED_TOPIC_PREFIX = "ph:v2";

/** Cleanup function returned by startOperationSync — called on reconnect to prevent subscriber leaks */
let cleanupSync: (() => void) | undefined;

/** Idempotency guard — prevents double-init on HMR or duplicate processor registration */
let initPromise: Promise<void> | undefined;

/** Guard: only register the beforeunload listener once */
let beforeUnloadRegistered = false;

// ═══════════════════════════════════════════════════════════════
// Processor Builder (the single export consumed by index.ts)
// ═══════════════════════════════════════════════════════════════

export const swarmPluginProcessorBuilder: ProcessorFactoryBuilder =
  async (_module: IProcessorHostModule) => {
    if (typeof window !== "undefined" && !initPromise) {
      initPromise = initSwarmPlugin().catch((err) => {
        console.warn("[SwarmPlugin] Init failed:", err);
        initPromise = undefined; // Allow retry on next registration
      });
    }

    return async (
      _driveHeader: PHDocumentHeader,
      _processorApp?: string,
    ) => {
      return [];
    };
  };

// ═══════════════════════════════════════════════════════════════
// Bee Node Detection
// ═══════════════════════════════════════════════════════════════

async function detectDevMode(): Promise<boolean> {
  try {
    const res = await fetch(`${state.beeUrl}/topology`);
    const data = (await res.json()) as { connected?: number };
    return (data.connected ?? 0) === 0;
  } catch {
    return false;
  }
}

type BeeStampInfo = {
  batchID: string;
  usable: boolean;
  depth: number;
  amount: string;
  bucketDepth: number;
  immutableFlag: boolean;
  exists: boolean;
  batchTTL: number;
  utilization: number;
};

async function fetchAllStamps(): Promise<BeeStampInfo[]> {
  const res = await fetch(`${state.beeUrl}/stamps`);
  const data = (await res.json()) as { stamps: BeeStampInfo[] };
  return data.stamps ?? [];
}

/** Pick the best usable stamp: user preference > mutable > immutable, highest TTL wins ties */
async function fetchUsableStamp(): Promise<{ batchID: string } | null> {
  const stamps = await fetchAllStamps();
  const usable = stamps.filter((s) => s.usable);
  if (usable.length === 0) return null;

  // Check if user has a preferred stamp
  try {
    const preferred = localStorage.getItem("swarm:preferredStamp");
    if (preferred) {
      const match = usable.find((s) => s.batchID === preferred);
      if (match) {
        console.log(`[SwarmPlugin] Using preferred stamp: ${preferred.slice(0, 12)}...`);
        return match;
      }
    }
  } catch {}

  // Prefer mutable stamps (immutableFlag === false)
  const mutable = usable.filter((s) => !s.immutableFlag);
  if (mutable.length > 0) {
    mutable.sort((a, b) => b.batchTTL - a.batchTTL);
    console.log(`[SwarmPlugin] Auto-selected mutable stamp: ${mutable[0].batchID.slice(0, 12)}...`);
    return mutable[0];
  }
  // Fallback to any usable stamp, highest TTL first
  usable.sort((a, b) => b.batchTTL - a.batchTTL);
  return usable[0];
}

/**
 * Wait for the Bee node to become reachable. Checks immediately, then
 * retries every 15 seconds in the background. Returns true once healthy.
 * This prevents the user from having to refresh the page when the Bee
 * node starts after Connect.
 */
const BEE_HEALTH_RETRY_MS = 15_000;

/** Abort controller for the current waitForBeeNode loop — aborted when setBeeUrl restarts init */
let waitAbort: AbortController | undefined;

async function waitForBeeNode(): Promise<boolean> {
  // Cancel any previous wait loop
  waitAbort?.abort();
  waitAbort = new AbortController();
  const { signal } = waitAbort;

  let retryCount = 0;
  while (!signal.aborted) {
    try {
      const fetchCtrl = new AbortController();
      const timeout = setTimeout(() => fetchCtrl.abort(), 3000);
      const onAbort = () => fetchCtrl.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(`${state.beeUrl}/health`, { signal: fetchCtrl.signal });
        clearTimeout(timeout);
        if (res.ok) {
          signal.removeEventListener("abort", onAbort);
          console.log("[SwarmPlugin] Bee node is reachable");
          return true;
        }
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
      }
    } catch {
      if (signal.aborted) return false;
    }

    retryCount++;
    // Log only first 3 retries to avoid flooding the console
    if (retryCount <= 3) {
      console.log(`[SwarmPlugin] Bee node not reachable at ${state.beeUrl} — retrying in ${BEE_HEALTH_RETRY_MS / 1000}s (attempt ${retryCount})`);
    }
    setSwarmStatus("disconnected", `Bee node not reachable at ${state.beeUrl}. Retrying automatically...`);
    // Only emit the event once — the toast subscription handles the one-time notification
    if (retryCount === 1) {
      emitSwarmEvent("plugin:retrying", { beeUrl: state.beeUrl, retryInMs: BEE_HEALTH_RETRY_MS });
    }
    await new Promise((r) => {
      const timer = setTimeout(r, BEE_HEALTH_RETRY_MS);
      const onAbortWait = () => { clearTimeout(timer); r(undefined); };
      signal.addEventListener("abort", onAbortWait, { once: true });
    });
  }
  return false; // Aborted — a new init will take over
}

// ═══════════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════════

export async function initSwarmPlugin(): Promise<void> {
  setSwarmStatus("initializing", "Connecting to Bee node...");

  // Load persisted drive mappings from localStorage so hydration
  // knows which local drives correspond to which Swarm drives
  loadDriveMapping();

  // Make setBeeUrl + beeUrl available IMMEDIATELY so the user can change
  // the Bee URL in the settings UI before the node is connected.
  const ph = (globalThis as any).window?.ph;
  if (ph) {
    if (!ph.swarm) ph.swarm = { status: "initializing", statusMessage: "Connecting to Bee node..." };
    // Install event system EARLY so toast subscriptions can catch plugin:retrying
    installEventHandlers(ph.swarm);
    ph.swarm.beeUrl = state.beeUrl;
    ph.swarm.setBeeUrl = async (url: string) => {
      const cleaned = url.trim().replace(/\/+$/, "");
      if (!cleaned) return;
      persistBeeUrl(cleaned);
      state.beeUrl = cleaned;
      if (ph.swarm) ph.swarm.beeUrl = cleaned;
      console.log(`[SwarmPlugin] Bee URL changed to ${cleaned} — restarting init...`);
      // Abort the current waitForBeeNode loop and restart init fresh
      waitAbort?.abort();
      initPromise = undefined;
      initPromise = initSwarmPlugin().catch((err) => {
        console.warn("[SwarmPlugin] Re-init failed:", err);
        initPromise = undefined;
      });
    };

    // getAllStamps: fetch every stamp on the Bee node for the stamp picker UI
    ph.swarm.getAllStamps = async () => {
      try { return await fetchAllStamps(); } catch { return []; }
    };

    // switchStamp: select a different stamp and reconnect
    ph.swarm.switchStamp = async (batchId: string) => {
      console.log(`[SwarmPlugin] Switching to stamp ${batchId.slice(0, 12)}...`);
      // Store selected stamp preference
      try { localStorage.setItem("swarm:preferredStamp", batchId); } catch {}
      // Reconnect — the plugin will pick up the preferred stamp
      waitAbort?.abort();
      initPromise = undefined;
      initPromise = initSwarmPlugin().catch((err) => {
        console.warn("[SwarmPlugin] Switch failed:", err);
        initPromise = undefined;
      });
    };
  }

  // Wait for Bee node to become reachable — retries every 15s in the background
  const healthy = await waitForBeeNode();
  if (!healthy) return; // Should not happen (loops until success or page close)

  setSwarmStatus("initializing", "Checking postage stamps...");

  const usableStamp = await fetchUsableStamp();
  if (!usableStamp) {
    console.log("[SwarmPlugin] No usable stamp on Bee node");
    setSwarmStatus("no-stamp", "No usable postage stamp found. Buy a stamp to start syncing to Swarm.");
    return;
  }

  const isDevMode = await detectDevMode();
  if (isDevMode) {
    console.log("[SwarmPlugin] Bee running in dev mode (no peers)");
  }

  // Pre-load manifest index BEFORE creating plugin
  const savedIndex = await loadManifestIndex();
  if (savedIndex.size > 0) {
    console.log(`[SwarmPlugin] Loaded ${savedIndex.size} manifest index entries from cache`);
  }

  const plugin = new SwarmConnectPlugin({
    beeUrl: state.beeUrl,
    batchId: usableStamp.batchID,
    useFeedMode: true,
    feedTopicPrefix: FEED_TOPIC_PREFIX,
    stampCheckIntervalMs: 300_000,
    onUserManifestLoaded: (manifest) => {
      const driveCount = Object.keys(manifest.drives ?? {}).length;
      console.log(`[SwarmPlugin] ${driveCount} drives found on Swarm`);

      populateUiCacheFromDrives(manifest).catch((err) =>
        console.warn("[SwarmPlugin] UI cache population failed:", err instanceof Error ? err.message : err));

      if (driveCount > 0) {
        // Old hydration disabled — SwarmChannel inbox pull handles recovery
        // via SyncManager + reactor.load() which preserves original IDs.
        // To re-enable old hydration (e.g. if SwarmChannel is removed),
        // uncomment the following:
        //
        // hydrateFromSwarm(manifest).catch((err) =>
        //   console.warn("[SwarmPlugin] Hydration failed:", err),
        // );
        console.log(`[SwarmPlugin] ${driveCount} drives on Swarm — recovery via SwarmChannel inbox pull`);
      }
    },
    onSignatureRequired: () => {
      console.log("[SwarmPlugin] Wallet signature needed");
      setSwarmStatus("initializing", "Wallet signature required — please sign in your wallet.");
    },
    onReady: (client, entry) => {
      console.log(
        `[SwarmPlugin] Ready — ${entry.ownerAddress.slice(0, 10)}...`,
      );
      setSwarmStatus("ready", "Connected to Swarm");
      emitSwarmEvent("plugin:ready", { ownerAddress: entry.ownerAddress, beeUrl: state.beeUrl, isDevMode });
      const ph = (globalThis as any).window?.ph;
      if (ph?.swarm) {
        ph.swarm.isDevMode = isDevMode;
      }

      // Restore manifest index synchronously
      const swarm = client as SwarmClient;
      if (savedIndex.size > 0) {
        swarm.setManifestIndex(savedIndex);
      }

      // Publish public profile (non-blocking, best-effort)
      publishPublicProfile(swarm, entry.ownerAddress, entry.swarmPublicKey).catch(
        (err) => console.warn("[SwarmPlugin] Profile publish failed:", err),
      );

      startOperationSync(swarm, entry.ownerAddress).then(
        (cleanup) => { cleanupSync = cleanup; },
        (err) => console.warn("[SwarmPlugin] Sync setup failed:", err),
      );
    },
  });

  await plugin.start();

  // plugin.start() overwrites ph.swarm — apply all our custom fields
  applySwarmExtensions((globalThis as any).window?.ph, isDevMode);

  // On page unload: pending ops are already persisted to IndexedDB (on every buffer).
  // Set a synchronous localStorage flag so the next session knows to replay them.
  // We do NOT attempt async flushes here — browsers abort them.
  // Guard: only register once (initSwarmPlugin can be called multiple times via setBeeUrl/reconnect)
  if (typeof window !== "undefined" && !beforeUnloadRegistered) {
    beforeUnloadRegistered = true;
    window.addEventListener("beforeunload", () => {
      if (state.pendingOps.size > 0) {
        const addr = (globalThis as any).window?.ph?.renown?.user?.address;
        markPendingOpsExist(addr);
      }
    });
  }

  console.log("[SwarmPlugin] Initialized");
}

// ═══════════════════════════════════════════════════════════════
// Apply custom fields to ph.swarm (survives plugin.start() overwrite)
// ═══════════════════════════════════════════════════════════════

function applySwarmExtensions(ph: any, isDevMode: boolean): void {
  if (!ph?.swarm) return;

  ph.swarm.isDevMode = isDevMode;
  ph.swarm.totalBytesUploaded = getUploadedBytes();
  ph.swarm.beeUrl = state.beeUrl;
  if (!ph.swarm.syncStatus) ph.swarm.syncStatus = {};

  // Install event system: window.ph.swarm.on("sync:confirmed", callback)
  installEventHandlers(ph.swarm);

  // If not ready yet (waiting for wallet login), show initializing status
  if (!ph.swarm.ready) {
    ph.swarm.status = "initializing";
    ph.swarm.statusMessage = "Waiting for wallet login...";
  }

  // setBeeUrl: change endpoint, persist in localStorage, and reconnect
  ph.swarm.setBeeUrl = async (url: string) => {
    const cleaned = url.trim().replace(/\/+$/, "");
    if (!cleaned) return;
    persistBeeUrl(cleaned);
    state.beeUrl = cleaned;
    if (ph.swarm) ph.swarm.beeUrl = cleaned;
    console.log(`[SwarmPlugin] Bee URL changed to ${cleaned} — reconnecting...`);
    if (ph.swarm?.reconnect) await ph.swarm.reconnect();
  };

  // clearStorage: writes empty manifests to all feeds
  ph.swarm.clearStorage = async () => {
    const client = ph.swarm?.client as SwarmClient | undefined;
    const address = ph.renown?.user?.address;
    if (!client || !address) {
      console.warn("[SwarmPlugin] Cannot clear — no client or address");
      return;
    }
    await clearSwarmStorage(client, address);
  };

  // getNodeStatus: rich node health snapshot (mode, peers, reachable, neighborhood)
  ph.swarm.getNodeStatus = async () => {
    const client = ph.swarm?.client as SwarmClient | undefined;
    if (!client) return null;
    try { return await client.getNodeStatus(); } catch { return null; }
  };

  // isContentAvailable: stewardship check — is content still retrievable?
  ph.swarm.isContentAvailable = async (reference: string) => {
    const client = ph.swarm?.client as SwarmClient | undefined;
    if (!client) return false;
    return client.isContentAvailable(reference);
  };

  // reuploadContent: re-stamp chunks for content aging out of the network
  ph.swarm.reuploadContent = async (reference: string) => {
    const client = ph.swarm?.client as SwarmClient | undefined;
    if (!client) throw new Error("Swarm client not connected");
    return client.reuploadContent(reference);
  };

  // getBucketUtilization: per-bucket fill levels and hot bucket detection
  ph.swarm.getBucketUtilization = async () => {
    const client = ph.swarm?.client as SwarmClient | undefined;
    if (!client) return null;
    try { return await client.getBucketUtilization(); } catch { return null; }
  };

  // getAllStamps: list all stamps on the Bee node for the stamp picker UI
  ph.swarm.getAllStamps = async () => {
    try { return await fetchAllStamps(); } catch { return []; }
  };

  // switchStamp: select a different stamp and reconnect
  ph.swarm.switchStamp = async (batchId: string) => {
    console.log(`[SwarmPlugin] Switching to stamp ${batchId.slice(0, 12)}...`);
    try { localStorage.setItem("swarm:preferredStamp", batchId); } catch {}
    if (ph.swarm?.reconnect) await ph.swarm.reconnect();
  };

  // refreshBalances: re-fetch node wallet balances
  ph.swarm.refreshBalances = async () => {
    try {
      const res = await fetch(`${state.beeUrl}/wallet`);
      const data = (await res.json()) as { bzzBalance?: string; nativeTokenBalance?: string };
      const balances = { xBZZ: data.bzzBalance ?? "0", xDAI: data.nativeTokenBalance ?? "0" };
      const walletRes = await fetch(`${state.beeUrl}/addresses`);
      const walletData = (await walletRes.json()) as { ethereum?: string };
      if (ph.swarm) {
        ph.swarm.nodeBalances = balances;
        ph.swarm.nodeWallet = walletData.ethereum;
      }
    } catch { /* node unreachable */ }
  };

  // refreshStamp: lightweight refresh — just re-read stamp status without full reconnect
  // Use this after top-up/expand/create operations
  ph.swarm.refreshStamp = async () => {
    console.log("[SwarmPlugin] Refreshing stamp status...");
    const client = ph.swarm?.client as SwarmClient | undefined;
    if (!client) return;
    try {
      const stampStatus = await client.getStampStatus();
      if (ph.swarm) {
        ph.swarm.stampStatus = stampStatus;
        ph.swarm.ready = true;
        ph.swarm.status = "ready";
      }
      // Also refresh wallet balances
      try {
        const res = await fetch(`${state.beeUrl}/wallet`);
        const data = (await res.json()) as { bzzBalance?: string; nativeTokenBalance?: string };
        if (ph.swarm) {
          ph.swarm.nodeBalances = { xBZZ: data.bzzBalance ?? "0", xDAI: data.nativeTokenBalance ?? "0" };
        }
      } catch {}
      console.log("[SwarmPlugin] Stamp status refreshed");
    } catch (err) {
      console.warn("[SwarmPlugin] Stamp refresh failed:", err);
    }
  };

  // reconnect: full reconnect — re-derive key, create fresh plugin with current beeUrl
  // Only needed when switching Bee URL or clearing cache — NOT for stamp operations
  ph.swarm.reconnect = async () => {
    console.log("[SwarmPlugin] Reconnecting...");
    // Do NOT clear the key cache — reuse the existing derived key

    const renown = ph.renown;
    const address = renown?.user?.address;
    if (!address) return;

    const freshStamp = await fetchUsableStamp();
    if (!freshStamp) {
      console.warn("[SwarmPlugin] No usable stamp for reconnect");
      return;
    }

    if (ph.swarm) ph.swarm.ready = false;

    // Re-probe dev mode — Bee URL may have changed to a different node
    const freshIsDevMode = await detectDevMode();

    try {
      const freshPlugin = new SwarmConnectPlugin({
        beeUrl: state.beeUrl,
        batchId: freshStamp.batchID,
        useFeedMode: true,
        feedTopicPrefix: FEED_TOPIC_PREFIX,
        stampCheckIntervalMs: 300_000,
        onUserManifestLoaded: (manifest) => {
          const driveCount = Object.keys(manifest.drives ?? {}).length;
          console.log(`[SwarmPlugin] ${driveCount} drives found on Swarm`);

          populateUiCacheFromDrives(manifest).catch((err) =>
            console.warn("[SwarmPlugin] UI cache population failed:", err instanceof Error ? err.message : err));

          if (driveCount > 0) {
            hydrateFromSwarm(manifest).catch((err) =>
              console.warn("[SwarmPlugin] Hydration failed:", err),
            );
          }
        },
        onSignatureRequired: () => console.log("[SwarmPlugin] Wallet signature needed"),
        onReady: (client, readyEntry) => {
          console.log(`[SwarmPlugin] Reconnected — ${readyEntry.ownerAddress.slice(0, 10)}... (${state.beeUrl})`);
          // Re-apply all custom fields since freshPlugin.start() overwrote ph.swarm
          applySwarmExtensions(ph, freshIsDevMode);
          if (ph.swarm) ph.swarm.plugin = freshPlugin;

          publishPublicProfile(client as SwarmClient, address, readyEntry.swarmPublicKey).catch(
            (err) => console.warn("[SwarmPlugin] Profile publish failed:", err),
          );
          // Clean up old subscriber before creating a new one
          if (cleanupSync) { cleanupSync(); cleanupSync = undefined; }
          startOperationSync(client as SwarmClient, readyEntry.ownerAddress).then(
            (cleanup) => { cleanupSync = cleanup; },
            (err) => console.warn("[SwarmPlugin] Sync setup failed:", err),
          );
        },
      });

      await freshPlugin.start();
      // freshPlugin.start() overwrites ph.swarm — re-apply fields
      applySwarmExtensions(ph, freshIsDevMode);
      if (ph.swarm) ph.swarm.plugin = freshPlugin;
      console.log("[SwarmPlugin] Reconnected successfully");
    } catch (err) {
      console.warn("[SwarmPlugin] Reconnect failed:", err);
    }
  };

  // shareDocuments: batch share multiple docs
  ph.swarm.shareDocuments = async (docIds: string[], recipientAddress: string) => {
    const client = ph.swarm?.client as SwarmClient | undefined;
    const address = ph.renown?.user?.address;
    if (!client || !address) throw new Error("Not connected to Swarm");
    return shareDocumentsWithUser(client, docIds, recipientAddress);
  };

  // importSharedDocuments: import documents shared by another user
  ph.swarm.importSharedDocuments = async (senderAddress: string) => {
    const client = ph.swarm?.client as SwarmClient | undefined;
    const address = ph.renown?.user?.address;
    if (!client || !address) throw new Error("Not connected to Swarm");
    return importFromUser(client, senderAddress);
  };

  // lookupUser: check if a user has a public profile on Swarm
  ph.swarm.lookupUser = async (targetAddress: string) => {
    const client = ph.swarm?.client as SwarmClient | undefined;
    if (!client) throw new Error("Not connected to Swarm");
    return client.readPublicProfile(targetAddress);
  };
}
