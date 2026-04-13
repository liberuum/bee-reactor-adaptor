import { SwarmConnectPlugin } from "../connect-plugin.js";
import { state, setSwarmStatus, getUploadedBytes, persistBeeUrl, loadDriveMapping } from "./state.js";
import { loadManifestIndex, clearSwarmStorage } from "./storage.js";
import { populateUiCacheFromDrives } from "./hydration.js";
import { publishPublicProfile, shareDocumentsWithUser, importFromUser } from "./sharing.js";
import { installEventHandlers, emitSwarmEvent } from "./events.js";
const FEED_TOPIC_PREFIX = "ph:v2";
/** Idempotency guard — prevents double-init on HMR or duplicate processor registration */
let initPromise;
// ═══════════════════════════════════════════════════════════════
// Processor Builder (the single export consumed by index.ts)
// ═══════════════════════════════════════════════════════════════
export const swarmPluginProcessorBuilder = async (_module) => {
    if (typeof window !== "undefined" && !initPromise) {
        initPromise = initSwarmPlugin().catch((err) => {
            console.warn("[SwarmPlugin] Init failed:", err);
            initPromise = undefined; // Allow retry on next registration
        });
    }
    return async (_driveHeader, _processorApp) => {
        return [];
    };
};
// ═══════════════════════════════════════════════════════════════
// Bee Node Detection
// ═══════════════════════════════════════════════════════════════
async function detectDevMode() {
    try {
        const res = await fetch(`${state.beeUrl}/topology`);
        const data = (await res.json());
        return (data.connected ?? 0) === 0;
    }
    catch {
        return false;
    }
}
async function fetchAllStamps() {
    const res = await fetch(`${state.beeUrl}/stamps`);
    const data = (await res.json());
    return data.stamps ?? [];
}
/** Pick the best usable stamp: user preference > mutable > immutable, highest TTL wins ties */
async function fetchUsableStamp() {
    const stamps = await fetchAllStamps();
    const usable = stamps.filter((s) => s.usable);
    if (usable.length === 0)
        return null;
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
    }
    catch { }
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
let waitAbort;
async function waitForBeeNode() {
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
            }
            finally {
                clearTimeout(timeout);
                signal.removeEventListener("abort", onAbort);
            }
        }
        catch {
            if (signal.aborted)
                return false;
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
export async function initSwarmPlugin() {
    setSwarmStatus("initializing", "Connecting to Bee node...");
    // Load persisted drive mappings from localStorage so hydration
    // knows which local drives correspond to which Swarm drives
    loadDriveMapping();
    // Make setBeeUrl + beeUrl available IMMEDIATELY so the user can change
    // the Bee URL in the settings UI before the node is connected.
    const ph = globalThis.window?.ph;
    if (ph) {
        if (!ph.swarm)
            ph.swarm = { status: "initializing", statusMessage: "Connecting to Bee node..." };
        // Install event system EARLY so toast subscriptions can catch plugin:retrying
        installEventHandlers(ph.swarm);
        ph.swarm.beeUrl = state.beeUrl;
        ph.swarm.setBeeUrl = async (url) => {
            const cleaned = url.trim().replace(/\/+$/, "");
            if (!cleaned)
                return;
            persistBeeUrl(cleaned);
            state.beeUrl = cleaned;
            if (ph.swarm)
                ph.swarm.beeUrl = cleaned;
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
            try {
                return await fetchAllStamps();
            }
            catch {
                return [];
            }
        };
        // switchStamp: select a different stamp and reconnect
        ph.swarm.switchStamp = async (batchId) => {
            console.log(`[SwarmPlugin] Switching to stamp ${batchId.slice(0, 12)}...`);
            // Store selected stamp preference
            try {
                localStorage.setItem("swarm:preferredStamp", batchId);
            }
            catch { }
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
    if (!healthy)
        return; // Should not happen (loops until success or page close)
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
            console.log(`[SwarmPlugin] ${driveCount} drives found on Swarm — recovery via SwarmChannel inbox pull`);
            populateUiCacheFromDrives(manifest).catch((err) => console.warn("[SwarmPlugin] UI cache population failed:", err instanceof Error ? err.message : err));
        },
        onSignatureRequired: () => {
            console.log("[SwarmPlugin] Wallet signature needed");
            setSwarmStatus("initializing", "Wallet signature required — please sign in your wallet.");
        },
        onReady: (client, entry) => {
            console.log(`[SwarmPlugin] Ready — ${entry.ownerAddress.slice(0, 10)}...`);
            setSwarmStatus("ready", "Connected to Swarm");
            emitSwarmEvent("plugin:ready", { ownerAddress: entry.ownerAddress, beeUrl: state.beeUrl, isDevMode });
            const ph = globalThis.window?.ph;
            if (ph?.swarm) {
                ph.swarm.isDevMode = isDevMode;
            }
            // Restore manifest index synchronously
            const swarm = client;
            if (savedIndex.size > 0) {
                swarm.setManifestIndex(savedIndex);
            }
            // Publish public profile (non-blocking, best-effort)
            publishPublicProfile(swarm, entry.ownerAddress, entry.swarmPublicKey).catch((err) => console.warn("[SwarmPlugin] Profile publish failed:", err));
            console.log("[SwarmPlugin] SwarmChannel handles push + pull");
        },
    });
    await plugin.start();
    // plugin.start() overwrites ph.swarm — apply all our custom fields
    applySwarmExtensions(globalThis.window?.ph, isDevMode);
    console.log("[SwarmPlugin] Initialized");
}
// ═══════════════════════════════════════════════════════════════
// Apply custom fields to ph.swarm (survives plugin.start() overwrite)
// ═══════════════════════════════════════════════════════════════
function applySwarmExtensions(ph, isDevMode) {
    if (!ph?.swarm)
        return;
    ph.swarm.isDevMode = isDevMode;
    ph.swarm.totalBytesUploaded = getUploadedBytes();
    ph.swarm.beeUrl = state.beeUrl;
    if (!ph.swarm.syncStatus)
        ph.swarm.syncStatus = {};
    // Install event system: window.ph.swarm.on("sync:confirmed", callback)
    installEventHandlers(ph.swarm);
    // If not ready yet (waiting for wallet login), show initializing status
    if (!ph.swarm.ready) {
        ph.swarm.status = "initializing";
        ph.swarm.statusMessage = "Waiting for wallet login...";
    }
    // setBeeUrl: change endpoint, persist in localStorage, and reconnect
    ph.swarm.setBeeUrl = async (url) => {
        const cleaned = url.trim().replace(/\/+$/, "");
        if (!cleaned)
            return;
        persistBeeUrl(cleaned);
        state.beeUrl = cleaned;
        if (ph.swarm)
            ph.swarm.beeUrl = cleaned;
        console.log(`[SwarmPlugin] Bee URL changed to ${cleaned} — reconnecting...`);
        if (ph.swarm?.reconnect)
            await ph.swarm.reconnect();
    };
    // clearStorage: writes empty manifests to all feeds
    ph.swarm.clearStorage = async () => {
        const client = ph.swarm?.client;
        const address = ph.renown?.user?.address;
        if (!client || !address) {
            console.warn("[SwarmPlugin] Cannot clear — no client or address");
            return;
        }
        await clearSwarmStorage(client, address);
    };
    // getNodeStatus: rich node health snapshot (mode, peers, reachable, neighborhood)
    ph.swarm.getNodeStatus = async () => {
        const client = ph.swarm?.client;
        if (!client)
            return null;
        try {
            return await client.getNodeStatus();
        }
        catch {
            return null;
        }
    };
    // isContentAvailable: check if a document's operation batches are retrievable.
    // The UI passes a docId — we read its manifest to get Swarm references,
    // then check stewardship on the actual content hashes.
    ph.swarm.isContentAvailable = async (docId) => {
        const client = ph.swarm?.client;
        if (!client)
            return false;
        try {
            const manifest = await client.readManifest(docId);
            if (!manifest || manifest.operationBatches.length === 0)
                return false;
            // Check the latest batch reference
            const latestBatch = manifest.operationBatches[manifest.operationBatches.length - 1];
            return client.isContentAvailable(latestBatch.reference);
        }
        catch {
            return false;
        }
    };
    // reuploadContent: re-upload all operation batches for a document.
    // The UI passes a docId — we read its manifest and re-upload each batch.
    ph.swarm.reuploadContent = async (docId) => {
        const client = ph.swarm?.client;
        if (!client)
            throw new Error("Swarm client not connected");
        const manifest = await client.readManifest(docId);
        if (!manifest)
            throw new Error("No manifest found for document");
        for (const batch of manifest.operationBatches) {
            await client.reuploadContent(batch.reference);
        }
    };
    // getBucketUtilization: per-bucket fill levels and hot bucket detection
    ph.swarm.getBucketUtilization = async () => {
        const client = ph.swarm?.client;
        if (!client)
            return null;
        try {
            return await client.getBucketUtilization();
        }
        catch {
            return null;
        }
    };
    // getAllStamps: list all stamps on the Bee node for the stamp picker UI
    ph.swarm.getAllStamps = async () => {
        try {
            return await fetchAllStamps();
        }
        catch {
            return [];
        }
    };
    // switchStamp: select a different stamp and reconnect
    ph.swarm.switchStamp = async (batchId) => {
        console.log(`[SwarmPlugin] Switching to stamp ${batchId.slice(0, 12)}...`);
        try {
            localStorage.setItem("swarm:preferredStamp", batchId);
        }
        catch { }
        if (ph.swarm?.reconnect)
            await ph.swarm.reconnect();
    };
    // refreshBalances: re-fetch node wallet balances
    ph.swarm.refreshBalances = async () => {
        try {
            const res = await fetch(`${state.beeUrl}/wallet`);
            const data = (await res.json());
            const balances = { xBZZ: data.bzzBalance ?? "0", xDAI: data.nativeTokenBalance ?? "0" };
            const walletRes = await fetch(`${state.beeUrl}/addresses`);
            const walletData = (await walletRes.json());
            if (ph.swarm) {
                ph.swarm.nodeBalances = balances;
                ph.swarm.nodeWallet = walletData.ethereum;
            }
        }
        catch { /* node unreachable */ }
    };
    // refreshStamp: lightweight refresh — just re-read stamp status without full reconnect
    // Use this after top-up/expand/create operations
    ph.swarm.refreshStamp = async () => {
        console.log("[SwarmPlugin] Refreshing stamp status...");
        const client = ph.swarm?.client;
        if (!client)
            return;
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
                const data = (await res.json());
                if (ph.swarm) {
                    ph.swarm.nodeBalances = { xBZZ: data.bzzBalance ?? "0", xDAI: data.nativeTokenBalance ?? "0" };
                }
            }
            catch { }
            console.log("[SwarmPlugin] Stamp status refreshed");
        }
        catch (err) {
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
        if (!address)
            return;
        const freshStamp = await fetchUsableStamp();
        if (!freshStamp) {
            console.warn("[SwarmPlugin] No usable stamp for reconnect");
            return;
        }
        if (ph.swarm)
            ph.swarm.ready = false;
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
                    populateUiCacheFromDrives(manifest).catch((err) => console.warn("[SwarmPlugin] UI cache population failed:", err instanceof Error ? err.message : err));
                },
                onSignatureRequired: () => console.log("[SwarmPlugin] Wallet signature needed"),
                onReady: (client, readyEntry) => {
                    console.log(`[SwarmPlugin] Reconnected — ${readyEntry.ownerAddress.slice(0, 10)}... (${state.beeUrl})`);
                    // Re-apply all custom fields since freshPlugin.start() overwrote ph.swarm
                    applySwarmExtensions(ph, freshIsDevMode);
                    if (ph.swarm)
                        ph.swarm.plugin = freshPlugin;
                    publishPublicProfile(client, address, readyEntry.swarmPublicKey).catch((err) => console.warn("[SwarmPlugin] Profile publish failed:", err));
                    console.log("[SwarmPlugin] Reconnected — SwarmChannel handles sync");
                },
            });
            await freshPlugin.start();
            // freshPlugin.start() overwrites ph.swarm — re-apply fields
            applySwarmExtensions(ph, freshIsDevMode);
            if (ph.swarm)
                ph.swarm.plugin = freshPlugin;
            console.log("[SwarmPlugin] Reconnected successfully");
        }
        catch (err) {
            console.warn("[SwarmPlugin] Reconnect failed:", err);
        }
    };
    // shareDocuments: batch share multiple docs
    ph.swarm.shareDocuments = async (docIds, recipientAddress) => {
        const client = ph.swarm?.client;
        const address = ph.renown?.user?.address;
        if (!client || !address)
            throw new Error("Not connected to Swarm");
        return shareDocumentsWithUser(client, docIds, recipientAddress);
    };
    // importSharedDocuments: import documents shared by another user
    ph.swarm.importSharedDocuments = async (senderAddress) => {
        const client = ph.swarm?.client;
        const address = ph.renown?.user?.address;
        if (!client || !address)
            throw new Error("Not connected to Swarm");
        return importFromUser(client, senderAddress);
    };
    // lookupUser: check if a user has a public profile on Swarm
    ph.swarm.lookupUser = async (targetAddress) => {
        const client = ph.swarm?.client;
        if (!client)
            throw new Error("Not connected to Swarm");
        return client.readPublicProfile(targetAddress);
    };
}
//# sourceMappingURL=init.js.map