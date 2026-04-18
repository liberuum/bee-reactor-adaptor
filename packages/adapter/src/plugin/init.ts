/**
 * Swarm Connect Plugin — Orchestrator
 *
 * Runs in the Connect browser context. Initializes the SwarmConnectPlugin
 * ASYNCHRONOUSLY — connects to Bee node, derives wallet key, starts sync.
 *
 * Sync is handled by SwarmChannel (native reactor IChannel).
 * This module handles: Bee detection, stamp selection, wallet key,
 * sharing, and UI cache population.
 */
import type {
  IProcessorHostModule,
  ProcessorFactoryBuilder,
} from "@powerhousedao/reactor";
import type { PHDocumentHeader } from "document-model";
import type { SwarmClient } from "../swarm-client.js";
import { ChatManager } from "../chat/chat-manager.js";
import { CollabManager } from "../collab/collab-manager.js";
import { SwarmConnectPlugin } from "../connect-plugin.js";
import { state, setSwarmStatus, getUploadedBytes, persistBeeUrl, loadDriveMapping } from "./state.js";
import { loadManifestIndex, clearSwarmStorage } from "./storage.js";
import { populateUiCacheFromDrives } from "./hydration.js";
import { publishPublicProfile, shareDocumentsWithUser, importFromUser } from "./sharing.js";
import { installEventHandlers, emitSwarmEvent } from "./events.js";
import {
  ensureChatPeerInUserManifest,
  clearChatPeersInUserManifest,
} from "../channel/manifest-manager.js";
import { bumpMyChatChapter } from "../chat/chat-history.js";

const FEED_TOPIC_PREFIX = "ph:v2";

/** Idempotency guard — prevents double-init on HMR or duplicate processor registration */
let initPromise: Promise<void> | undefined;

/**
 * (Re)build the ChatManager and wire it onto window.ph.swarm.chat.
 *
 * Called from both the initial plugin init and from reconnect (Bee URL
 * change). Without the reconnect call the chat panel shows "Chat is not
 * ready yet" after a URL switch because ph.swarm is overwritten by
 * freshPlugin.start() and ph.swarm.chat is never re-populated, even
 * though the underlying SwarmClient is healthy.
 */
async function initChatManager(
  beeUrl: string,
  plugin: SwarmConnectPlugin,
  stampBatchId: string,
): Promise<void> {
  const phAfterStart = (globalThis as any).window?.ph;
  const swarmClient = phAfterStart?.swarm?.client as SwarmClient | undefined;
  if (!swarmClient || !plugin.getSignerEntry()) return;

  try {
    // Shutdown any previous ChatManager to prevent duplicate PSS
    // subscriptions. We check TWO locations because plugin.start() can
    // wipe ph.swarm wholesale, orphaning the manager we put there — and
    // an orphaned manager keeps its broadcast-topic subscription alive
    // plus its onMessage handlers, so every incoming message logs N
    // times (once per leaked HMR reload). The globalThis mirror gives
    // us a stable handle that survives the ph.swarm rewrite.
    const g = globalThis as any;
    const candidates = [
      phAfterStart?.swarm?.chat?.manager,
      g.__swarmChatManager__,
    ];
    for (const prev of candidates) {
      if (prev && typeof prev.shutdown === "function") {
        try {
          prev.shutdown();
          console.log("[SwarmPlugin] Old ChatManager shut down");
        } catch (err) {
          console.warn("[SwarmPlugin] Old ChatManager shutdown failed:", err);
        }
      }
    }

    const { Bee } = await import("@ethersphere/bee-js");
    const bee = new Bee(beeUrl);
    const ownerAddress = swarmClient.getOwnerAddress();
    const chatManager = new ChatManager(swarmClient, bee, stampBatchId, ownerAddress);
    // Dedicated GSOC notifier for collab op-committed pings. Using its
    // own instance keeps collab subscriptions (under the `collab-notify`
    // identifier prefix) from cross-talking with chat's notifier.
    const { GsocNotifier } = await import("../chat/gsoc-notifier.js");
    const collabGsoc = new GsocNotifier(bee, stampBatchId, ownerAddress);
    const collabManager = new CollabManager(
      swarmClient,
      chatManager,
      ownerAddress,
      collabGsoc,
    );

    if (phAfterStart.swarm) {
      phAfterStart.swarm.chat = { manager: chatManager };
      phAfterStart.swarm.collab = { manager: collabManager };
    }
    // Also mirror on globalThis so we can always find and shut down
    // this manager even if ph.swarm gets reassigned by a later
    // plugin.start(). See the shutdown candidates list above.
    (globalThis as any).__swarmChatManager__ = chatManager;
    (globalThis as any).__swarmCollabManager__ = collabManager;

    // Persist incoming messages to localStorage at the plugin level.
    // This runs even when the chat panel is CLOSED, so the unread badge
    // on the sidebar can reflect new messages, and history survives
    // across app restarts.
    chatManager.onMessage((msg) => {
      console.log(`[Chat] Message from ${msg.from.slice(0, 10)}: ${msg.text.slice(0, 50)}`);
      try {
        const raw = localStorage.getItem("swarm:chatMessages");
        const entries: Array<[string, any[]]> = raw ? JSON.parse(raw) : [];
        const map = new Map<string, any[]>(entries);
        const peerKey = msg.from;
        const existing = map.get(peerKey) ?? [];
        if (existing.some((m: any) => m.id === msg.id)) return;
        const updated = [...existing, msg].slice(-100);
        map.set(peerKey, updated);
        localStorage.setItem("swarm:chatMessages", JSON.stringify([...map]));
        window.dispatchEvent(new CustomEvent("swarm:chatMessages:updated"));
      } catch (err) {
        console.warn("[Chat] Failed to persist message:", err instanceof Error ? err.message : err);
      }
    });

    console.log("[SwarmPlugin] ChatManager initialized");

    // Sync chat peers between localStorage and the Swarm user manifest.
    try {
      const raw = localStorage.getItem("swarm:chatMessages");
      const localEntries: Array<[string, any[]]> = raw ? JSON.parse(raw) : [];
      const localPeers = new Set(
        localEntries
          .map(([peerAddress]) => peerAddress?.toLowerCase?.())
          .filter((p) => typeof p === "string" && p.startsWith("0x")),
      );

      let seeded = 0;
      for (const peer of localPeers) {
        try {
          await ensureChatPeerInUserManifest(swarmClient, ownerAddress, peer);
          seeded++;
        } catch { /* best effort per peer */ }
      }
      if (seeded > 0) {
        console.log(
          `[SwarmPlugin] Seeded ${seeded} chat peer(s) into user manifest from localStorage`,
        );
      }

      const remotePeers = await chatManager.listKnownChatPeers();
      const toRecover = remotePeers.filter((p) => !localPeers.has(p.toLowerCase()));
      if (toRecover.length > 0) {
        const map = new Map<string, any[]>(localEntries);
        for (const peer of toRecover) {
          if (!map.has(peer)) map.set(peer, []);
        }
        try {
          localStorage.setItem("swarm:chatMessages", JSON.stringify([...map]));
          window.dispatchEvent(new CustomEvent("swarm:chatMessages:updated"));
        } catch { /* localStorage full or unavailable */ }
        console.log(
          `[SwarmPlugin] Recovered ${toRecover.length} chat peer(s) from user manifest`,
        );
      }
    } catch (err) {
      console.warn(
        "[SwarmPlugin] Chat-peer sync failed:",
        err instanceof Error ? err.message : err,
      );
    }
  } catch (err) {
    console.warn(
      "[SwarmPlugin] ChatManager init failed:",
      err instanceof Error ? err.message : err,
    );
  }
}


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

    // Provide a minimal client so the "Buy Stamp" UI can call createStamp()
    // and getStampOptions() even though the full SwarmConnectPlugin hasn't initialized.
    if (ph.swarm) {
      ph.swarm.client = {
        createStamp: async (amount: string, depth: number, options?: { immutable?: boolean }) => {
          const headers: Record<string, string> = {
            "Immutable": String(options?.immutable ?? false),
          };
          const response = await fetch(`${state.beeUrl}/stamps/${amount}/${depth}`, {
            method: "POST",
            headers,
          });
          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to create stamp: ${text}`);
          }
          const data = (await response.json()) as { batchID: string };
          return data.batchID;
        },
        getStampOptions: async () => {
          const res = await fetch(`${state.beeUrl}/chainstate`);
          if (!res.ok) throw new Error("Failed to get chainstate");
          const chain = (await res.json()) as { currentPrice: number; block: number };
          const pricePerBlock = chain.currentPrice;
          const blockTime = 5;
          const sizeOptions = [
            { depth: 19, label: "110 MB", effectiveBytes: 110_000_000 },
            { depth: 20, label: "680 MB", effectiveBytes: 680_000_000 },
            { depth: 21, label: "2.6 GB", effectiveBytes: 2_600_000_000 },
            { depth: 22, label: "7.7 GB", effectiveBytes: 7_700_000_000 },
            { depth: 23, label: "20 GB", effectiveBytes: 20_000_000_000 },
            { depth: 24, label: "47 GB", effectiveBytes: 47_000_000_000 },
            { depth: 25, label: "105 GB", effectiveBytes: 105_000_000_000 },
          ];
          const durationPresets = [1, 2, 7, 15, 30, 90, 180, 365];
          // Multiply by 2 to ensure the amount exceeds the Bee node's 24h minimum
          // validation. The currentPrice is the per-block drain rate, but the node
          // requires a safety margin above the bare minimum (price * blocks).
          const safetyMultiplier = 2n;
          const durationOptions = durationPresets.map((days) => {
            const blocks = Math.ceil((days * 86400) / blockTime);
            const amount = BigInt(blocks) * BigInt(pricePerBlock) * safetyMultiplier;
            return {
              days,
              label: days === 1 ? "~1 day" : days === 365 ? "~1 year" : `~${days} days`,
              amount: amount.toString(),
            };
          });
          return {
            currentDepth: 17,
            currentTtlSeconds: 0,
            pricePerBlock,
            blockTime,
            sizeOptions,
            durationOptions,
          };
        },
      };
    }
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
      console.log(`[SwarmPlugin] ${driveCount} drives found on Swarm — recovery via SwarmChannel inbox pull`);

      populateUiCacheFromDrives(manifest).catch((err) =>
        console.warn("[SwarmPlugin] UI cache population failed:", err instanceof Error ? err.message : err));
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

      console.log("[SwarmPlugin] SwarmChannel handles push + pull");
    },
  });

  await plugin.start();

  // plugin.start() overwrites ph.swarm — apply all our custom fields
  applySwarmExtensions((globalThis as any).window?.ph, isDevMode);

  // Initialize ChatManager (PSS + GSOC + ACT history)
  await initChatManager(state.beeUrl, plugin, usableStamp.batchID);

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

  // clearChats: wipe the user's conversation list. Local state (both
  // localStorage buckets + in-memory ChatManager sessions) is cleared,
  // and chatPeers is emptied from the user manifest so fresh browsers
  // no longer recover these conversations. Intentionally does NOT
  // touch chat history feeds or peer-side data:
  //   - Feeds are append-only on Swarm; overwriting with tombstones
  //     doesn't delete old entries, just adds noise the new reader
  //     skips. Stamps will expire chunks naturally.
  //   - Peer still sees everything on their side. If they message
  //     you again, a fresh conversation starts.
  ph.swarm.clearChats = async () => {
    const client = ph.swarm?.client as SwarmClient | undefined;
    const swarmAddress = client?.getOwnerAddress?.();
    if (!client || !swarmAddress) {
      console.warn("[SwarmPlugin] Cannot clear chats — no client or address");
      return;
    }

    // 1. Shut down the ChatManager so PSS subscriptions close and
    //    pending feed writes don't resurrect peers we're clearing.
    const chatManager = ph.swarm?.chat?.manager;
    if (chatManager && typeof chatManager.shutdown === "function") {
      try {
        chatManager.shutdown();
        console.log("[SwarmPlugin] ChatManager shut down for clear");
      } catch (err) {
        console.warn("[SwarmPlugin] ChatManager shutdown failed:", err instanceof Error ? err.message : err);
      }
    }

    // 2. Bump the chat chapter — all future writes go to a NEW history
    //    feed, and the peer learns the rotation from my next PSS
    //    message. Old feeds are orphaned on Swarm and decay as stamps
    //    expire; we never ask Bee to delete (it can't).
    const newChapter = bumpMyChatChapter();
    console.log(`[SwarmPlugin] Chat chapter rotated to ${newChapter}`);

    // 3. Wipe local caches — conversation list + last-read + per-peer
    //    chapter map. The clearedAt timestamp still guards the broadcast
    //    subscriber against cached PSS replays resurrecting peers we
    //    just removed from the manifest.
    try {
      localStorage.removeItem("swarm:chatMessages");
      localStorage.removeItem("swarm:chatLastRead");
      localStorage.removeItem("swarm:chatPeerChapters");
      localStorage.setItem("swarm:chatsClearedAt", String(Date.now()));
      window.dispatchEvent(new CustomEvent("swarm:chatMessages:updated"));
      window.dispatchEvent(new CustomEvent("swarm:chatLastRead:updated"));
      window.dispatchEvent(new CustomEvent("swarm:chatsCleared"));
    } catch { /* localStorage unavailable */ }

    // 4. Remove chatPeers from the user manifest so a fresh browser
    //    (or this one after reload) has nothing to recover.
    try {
      await clearChatPeersInUserManifest(client, swarmAddress);
    } catch (err) {
      console.warn(
        "[SwarmPlugin] clearChats: manifest clear failed:",
        err instanceof Error ? err.message : err,
      );
    }

    // 5. Re-initialize ChatManager so the user can immediately start a
    //    new conversation without reloading.
    const usable = await fetchUsableStamp();
    if (usable && ph.swarm?.plugin) {
      await initChatManager(state.beeUrl, ph.swarm.plugin, usable.batchID);
    }

    console.log("[SwarmPlugin] Chats cleared — conversation list is empty. Ready for fresh chats.");
  };

  // getNodeStatus: rich node health snapshot (mode, peers, reachable, neighborhood)
  ph.swarm.getNodeStatus = async () => {
    const client = ph.swarm?.client as SwarmClient | undefined;
    if (!client) return null;
    try { return await client.getNodeStatus(); } catch { return null; }
  };

  // isContentAvailable: check if a document's operation batches are retrievable.
  // The UI passes a docId — we read its manifest to get Swarm references,
  // then check stewardship on the actual content hashes.
  ph.swarm.isContentAvailable = async (docId: string) => {
    const client = ph.swarm?.client as SwarmClient | undefined;
    if (!client) return false;
    try {
      const manifest = await client.readManifest(docId);
      if (!manifest || manifest.operationBatches.length === 0) return false;
      // Check the latest batch reference
      const latestBatch = manifest.operationBatches[manifest.operationBatches.length - 1];
      return client.isContentAvailable(latestBatch.reference);
    } catch {
      return false;
    }
  };

  // reuploadContent: re-upload all operation batches for a document.
  // The UI passes a docId — we read its manifest and re-upload each batch.
  ph.swarm.reuploadContent = async (docId: string) => {
    const client = ph.swarm?.client as SwarmClient | undefined;
    if (!client) throw new Error("Swarm client not connected");
    const manifest = await client.readManifest(docId);
    if (!manifest) throw new Error("No manifest found for document");
    for (const batch of manifest.operationBatches) {
      await client.reuploadContent(batch.reference);
    }
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
          console.log(`[SwarmPlugin] ${driveCount} drives found on Swarm — recovery via SwarmChannel inbox pull`);

          populateUiCacheFromDrives(manifest).catch((err) =>
            console.warn("[SwarmPlugin] UI cache population failed:", err instanceof Error ? err.message : err));
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
          console.log("[SwarmPlugin] Reconnected — SwarmChannel handles sync");
        },
      });

      await freshPlugin.start();
      // freshPlugin.start() overwrites ph.swarm — re-apply fields
      applySwarmExtensions(ph, freshIsDevMode);
      if (ph.swarm) ph.swarm.plugin = freshPlugin;

      // Re-create the ChatManager against the new Bee/client — without this
      // the chat panel stays on "Chat is not ready yet" after a URL switch
      // because ph.swarm.chat was wiped by freshPlugin.start().
      await initChatManager(state.beeUrl, freshPlugin, freshStamp.batchID);

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
