import { SwarmConnectPlugin } from "./connect-plugin.js";
import { getOrDeriveSwarmKey } from "./wallet-signer.js";
const SWARM_BEE_URL_DEFAULT = "http://localhost:1633";
const SWARM_BEE_URL_KEY = "swarm:beeUrl";
/** Read the Bee URL from localStorage or fall back to default */
function getBeeUrl() {
    if (typeof window !== "undefined") {
        try {
            const saved = localStorage.getItem(SWARM_BEE_URL_KEY);
            if (saved && saved.trim())
                return saved.trim().replace(/\/+$/, "");
        }
        catch { /* localStorage unavailable */ }
    }
    return SWARM_BEE_URL_DEFAULT;
}
/** Mutable Bee URL — updated via settings UI, persisted in localStorage */
let SWARM_BEE_URL = getBeeUrl();
const FEED_TOPIC_PREFIX = "ph:v2";
export const swarmPluginProcessorBuilder = async (_module) => {
    if (typeof window !== "undefined") {
        initSwarmPlugin().catch((err) => {
            console.warn("[SwarmPlugin] Init failed:", err);
        });
    }
    return async (_driveHeader, _processorApp) => {
        return [];
    };
};
async function detectDevMode() {
    try {
        const res = await fetch(`${SWARM_BEE_URL}/topology`);
        const data = (await res.json());
        return (data.connected ?? 0) === 0;
    }
    catch {
        return false;
    }
}
async function fetchUsableStamp() {
    const res = await fetch(`${SWARM_BEE_URL}/stamps`);
    const data = (await res.json());
    return data.stamps.find((s) => s.usable) ?? null;
}
/** Update the swarm status on window.ph.swarm for the settings UI */
function setSwarmStatus(status, message) {
    const ph = globalThis.window?.ph;
    if (!ph)
        return;
    if (!ph.swarm) {
        ph.swarm = { status, statusMessage: message ?? "", syncStatus: {} };
    }
    else {
        ph.swarm.status = status;
        ph.swarm.statusMessage = message ?? "";
        if (!ph.swarm.syncStatus)
            ph.swarm.syncStatus = {};
    }
}
/** Update per-document sync status on window.ph.swarm.syncStatus */
function setDocSyncStatus(docId, state, pendingOpsCount) {
    const ph = globalThis.window?.ph;
    if (!ph?.swarm)
        return;
    if (!ph.swarm.syncStatus)
        ph.swarm.syncStatus = {};
    ph.swarm.syncStatus[docId] = { state, pendingOps: pendingOpsCount ?? 0, updatedAt: Date.now() };
}
async function initSwarmPlugin() {
    setSwarmStatus("initializing", "Connecting to Bee node...");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
        const healthRes = await fetch(`${SWARM_BEE_URL}/health`, {
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!healthRes.ok) {
            console.log("[SwarmPlugin] Bee node not available");
            setSwarmStatus("disconnected", "Bee node not available. Start a Bee node to enable Swarm storage.");
            return;
        }
    }
    catch {
        clearTimeout(timeout);
        console.log("[SwarmPlugin] Bee node not reachable at", SWARM_BEE_URL);
        setSwarmStatus("disconnected", `Bee node not reachable at ${SWARM_BEE_URL}. Install and start a Bee node to enable decentralized storage.`);
        return;
    }
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
    // SwarmConnectPlugin imported statically at top of file
    // Pre-load manifest index BEFORE creating plugin (must be synchronous in onReady)
    const savedIndex = await loadManifestIndex();
    if (savedIndex.size > 0) {
        console.log(`[SwarmPlugin] Loaded ${savedIndex.size} manifest index entries from cache`);
    }
    const plugin = new SwarmConnectPlugin({
        beeUrl: SWARM_BEE_URL,
        batchId: usableStamp.batchID,
        useFeedMode: true,
        feedTopicPrefix: FEED_TOPIC_PREFIX,
        stampCheckIntervalMs: 300_000,
        onUserManifestLoaded: (manifest) => {
            const driveCount = Object.keys(manifest.drives ?? {}).length;
            console.log(`[SwarmPlugin] ${driveCount} drives found on Swarm`);
            // Populate UI cache from drive manifests (so Settings tree shows docs on normal refresh)
            populateUiCacheFromDrives(manifest).catch((err) => console.warn("[SwarmPlugin] UI cache population failed:", err instanceof Error ? err.message : err));
            if (driveCount > 0) {
                hydrateFromSwarm(manifest).catch((err) => console.warn("[SwarmPlugin] Hydration failed:", err));
            }
        },
        onSignatureRequired: () => {
            console.log("[SwarmPlugin] Wallet signature needed");
            setSwarmStatus("initializing", "Wallet signature required — please sign in your wallet.");
        },
        onReady: (client, entry) => {
            console.log(`[SwarmPlugin] Ready — ${entry.ownerAddress.slice(0, 10)}...`);
            setSwarmStatus("ready", "Connected to Swarm");
            const ph = globalThis.window?.ph;
            if (ph?.swarm) {
                ph.swarm.isDevMode = isDevMode;
            }
            // Restore manifest index synchronously (onReady is NOT awaited by the plugin,
            // so this must complete before readUserManifest runs)
            const swarm = client;
            if (savedIndex.size > 0) {
                swarm.setManifestIndex(savedIndex);
            }
            // Publish public profile (non-blocking, best-effort)
            publishPublicProfile(swarm, entry.ownerAddress, entry.swarmPublicKey).catch((err) => console.warn("[SwarmPlugin] Profile publish failed:", err));
            startOperationSync(swarm, entry.ownerAddress).catch((err) => console.warn("[SwarmPlugin] Sync setup failed:", err));
        },
    });
    await plugin.start();
    // plugin.start() overwrites ph.swarm — apply all our custom fields.
    // This is extracted as a function so reconnect() can call it too,
    // since freshPlugin.start() also overwrites ph.swarm.
    const ph = globalThis.window?.ph;
    applySwarmExtensions(ph, isDevMode);
    // Flush pending document manifests before page unload to avoid data loss
    if (typeof window !== "undefined") {
        window.addEventListener("beforeunload", () => {
            for (const docId of pendingManifests.keys()) {
                flushDocumentManifest(docId).catch(() => { });
            }
            // Also flush pending drive manifests
            const swarm = globalThis.window?.ph?.swarm?.client;
            if (swarm) {
                for (const driveId of pendingDriveUpdates.keys()) {
                    flushDriveManifest(swarm, driveId).catch(() => { });
                }
            }
        });
    }
    console.log("[SwarmPlugin] Initialized");
}
// ─── Apply custom fields to ph.swarm (survives plugin.start() overwrite) ──
function applySwarmExtensions(ph, isDevMode) {
    if (!ph?.swarm)
        return;
    ph.swarm.isDevMode = isDevMode;
    ph.swarm.totalBytesUploaded = getUploadedBytes();
    ph.swarm.beeUrl = SWARM_BEE_URL;
    if (!ph.swarm.syncStatus)
        ph.swarm.syncStatus = {};
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
        try {
            localStorage.setItem(SWARM_BEE_URL_KEY, cleaned);
        }
        catch { /* */ }
        SWARM_BEE_URL = cleaned;
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
    // refreshBalances: re-fetch node wallet balances
    ph.swarm.refreshBalances = async () => {
        try {
            const res = await fetch(`${SWARM_BEE_URL}/wallet`);
            const data = (await res.json());
            const balances = { xBZZ: data.bzzBalance ?? "0", xDAI: data.nativeTokenBalance ?? "0" };
            const walletRes = await fetch(`${SWARM_BEE_URL}/addresses`);
            const walletData = (await walletRes.json());
            if (ph.swarm) {
                ph.swarm.nodeBalances = balances;
                ph.swarm.nodeWallet = walletData.ethereum;
            }
        }
        catch { /* node unreachable */ }
    };
    // reconnect: re-derive key, create fresh plugin with current SWARM_BEE_URL
    ph.swarm.reconnect = async () => {
        console.log("[SwarmPlugin] Reconnecting...");
        const currentPlugin = ph.swarm?.plugin;
        if (currentPlugin?.clearCache)
            await currentPlugin.clearCache();
        const renown = ph.renown;
        const address = renown?.user?.address;
        if (!address)
            return;
        const freshStamp = await fetchUsableStamp();
        if (!freshStamp) {
            console.warn("[SwarmPlugin] No usable stamp for reconnect");
            return;
        }
        const FreshPlugin = SwarmConnectPlugin;
        if (ph.swarm)
            ph.swarm.ready = false;
        const origin = typeof window !== "undefined" ? window.location.origin : undefined;
        try {
            await getOrDeriveSwarmKey(address, origin);
            const freshPlugin = new FreshPlugin({
                beeUrl: SWARM_BEE_URL,
                batchId: freshStamp.batchID,
                useFeedMode: true,
                feedTopicPrefix: FEED_TOPIC_PREFIX,
                stampCheckIntervalMs: 300_000,
                onUserManifestLoaded: (manifest) => {
                    console.log(`[SwarmPlugin] ${Object.keys(manifest.drives ?? {}).length} drives on Swarm`);
                },
                onSignatureRequired: () => console.log("[SwarmPlugin] Wallet signature needed"),
                onReady: (client, readyEntry) => {
                    console.log(`[SwarmPlugin] Reconnected — ${readyEntry.ownerAddress.slice(0, 10)}... (${SWARM_BEE_URL})`);
                    // Re-apply all custom fields since freshPlugin.start() overwrote ph.swarm
                    applySwarmExtensions(ph, isDevMode);
                    if (ph.swarm)
                        ph.swarm.plugin = freshPlugin;
                    publishPublicProfile(client, address, readyEntry.swarmPublicKey).catch((err) => console.warn("[SwarmPlugin] Profile publish failed:", err));
                    startOperationSync(client, readyEntry.ownerAddress).catch((err) => console.warn("[SwarmPlugin] Sync setup failed:", err));
                },
            });
            await freshPlugin.start();
            // freshPlugin.start() overwrites ph.swarm — re-apply fields
            applySwarmExtensions(ph, isDevMode);
            if (ph.swarm)
                ph.swarm.plugin = freshPlugin;
            console.log("[SwarmPlugin] Reconnected successfully");
        }
        catch (err) {
            console.warn("[SwarmPlugin] Reconnect failed:", err);
        }
    };
    // shareDocuments: batch share multiple docs (clean slate — replaces previous shares to this recipient)
    ph.swarm.shareDocuments = async (docIds, recipientAddress) => {
        const client = ph.swarm?.client;
        const address = ph.renown?.user?.address;
        if (!client || !address)
            throw new Error("Not connected to Swarm");
        return shareDocumentsWithUser(client, address, docIds, recipientAddress);
    };
    // importSharedDocuments: import documents shared by another user
    ph.swarm.importSharedDocuments = async (senderAddress) => {
        const client = ph.swarm?.client;
        const address = ph.renown?.user?.address;
        if (!client || !address)
            throw new Error("Not connected to Swarm");
        return importFromUser(client, address, senderAddress);
    };
    // lookupUser: check if a user has a public profile on Swarm
    ph.swarm.lookupUser = async (targetAddress) => {
        const client = ph.swarm?.client;
        if (!client)
            throw new Error("Not connected to Swarm");
        return client.readPublicProfile(targetAddress);
    };
}
/**
 * Populate ph.swarm.userManifest.documents from drive manifest feeds.
 * Called on every manifest load (not just recovery) so the Settings UI
 * tree view always has data — even when hydration is skipped.
 */
async function populateUiCacheFromDrives(userManifest) {
    const ph = globalThis.window?.ph;
    const swarmClient = ph?.swarm?.client;
    if (!swarmClient || !ph?.swarm)
        return;
    const drives = userManifest.drives ?? {};
    if (Object.keys(drives).length === 0)
        return;
    // Build documents map from drive manifests
    const documents = {};
    for (const [driveId, driveEntry] of Object.entries(drives)) {
        // Add drive entry
        documents[driveId] = {
            documentType: "powerhouse/document-drive",
            name: driveEntry.name || driveId,
            driveId: "",
            lastUpdated: driveEntry.lastUpdated || new Date().toISOString(),
        };
        // Read drive manifest to get docs
        try {
            const dm = await swarmClient.readDriveManifest(driveId);
            if (dm) {
                // Seed the local cache so flushDriveManifest never reads stale data from Swarm
                driveManifestCache.set(driveId, dm);
                for (const [docId, docEntry] of Object.entries(dm.documents)) {
                    documents[docId] = {
                        documentType: docEntry.documentType,
                        name: docEntry.name,
                        driveId,
                        parentFolder: docEntry.parentFolder || undefined,
                        lastUpdated: docEntry.lastUpdated,
                    };
                }
            }
        }
        catch { /* drive manifest not available yet */ }
    }
    // Populate docToDrive and driveNames from the drive manifests we just read
    // (this is the authoritative source — more reliable than reading from the user manifest)
    for (const [docId, entry] of Object.entries(documents)) {
        if (entry.driveId && entry.documentType !== "powerhouse/document-drive") {
            docToDrive.set(docId, entry.driveId);
        }
        if (entry.documentType === "powerhouse/document-drive" && entry.name) {
            driveNames.set(docId, entry.name);
        }
    }
    console.log(`[SwarmPlugin] Populated ${docToDrive.size} doc→drive mappings, ${driveNames.size} drive names from drive manifests`);
    // Update the UI cache
    if (!ph.swarm.userManifest) {
        ph.swarm.userManifest = { ...userManifest, documents };
    }
    else {
        ph.swarm.userManifest.documents = { ...ph.swarm.userManifest.documents, ...documents };
    }
    // Store drive manifest folder info for the Settings UI tree
    if (!ph.swarm.userManifest.driveManifests)
        ph.swarm.userManifest.driveManifests = {};
    for (const [driveId] of Object.entries(drives)) {
        const cached = driveManifestCache.get(driveId);
        if (cached?.folders) {
            ph.swarm.userManifest.driveManifests[driveId] = { folders: cached.folders };
        }
    }
}
// ─── Hydration (recovery from Swarm) ────────────────────────────
async function hydrateFromSwarm(userManifest) {
    const ph = globalThis.window?.ph;
    const reactorClient = ph?.reactorClient;
    const swarmClient = ph?.swarm?.client;
    if (!reactorClient || !swarmClient) {
        console.warn("[SwarmPlugin] Cannot hydrate — missing reactor or swarm client");
        return;
    }
    // Check if hydration already ran — but force it if local has no drives
    // (handles case where user cleared IndexedDB but sessionStorage persists)
    if (hydrationRan) {
        let localDriveCount = 0;
        try {
            const drives = await reactorClient.getDrives();
            localDriveCount = (drives ?? []).length;
        }
        catch { /* no drives */ }
        if (localDriveCount > 0) {
            console.log("[SwarmPlugin] Hydration already ran this session, skipping");
            return;
        }
        console.log("[SwarmPlugin] Hydration ran before but no local drives — forcing recovery");
    }
    hydrationRan = true;
    setHydrationRan(true);
    // Wait for reactor to fully initialize
    for (let i = 0; i < 20; i++) {
        try {
            const drives = await reactorClient.getDrives();
            if (drives && drives.length > 0)
                break;
        }
        catch { /* not ready */ }
        await new Promise((r) => setTimeout(r, 500));
    }
    // Build set of ALL doc IDs in local reactor (drives + their children)
    const localDocIds = new Set();
    try {
        const drives = await reactorClient.getDrives();
        for (const drive of (drives ?? [])) {
            const driveId = drive?.id ?? drive;
            localDocIds.add(driveId);
            try {
                const driveDoc = await reactorClient.get(driveId);
                const nodes = driveDoc?.state?.global?.nodes ?? [];
                for (const node of nodes) {
                    if (node.id)
                        localDocIds.add(node.id);
                }
            }
            catch { /* drive not accessible */ }
        }
    }
    catch { /* no drives */ }
    // ─── Recovery: Drive manifests are the source of truth ─────────
    // Read drive manifests to discover which docs belong to which drive.
    // User manifest only lists drives (not individual docs).
    const { addDrive } = await import("@powerhousedao/reactor-browser");
    const driveIds = [];
    const swarmDriveNames = new Map();
    if (userManifest.drives && Object.keys(userManifest.drives).length > 0) {
        for (const [driveId, entry] of Object.entries(userManifest.drives)) {
            driveIds.push(driveId);
            swarmDriveNames.set(driveId, entry.name || "Recovered Drive");
        }
    }
    if (driveIds.length === 0) {
        console.log("[SwarmPlugin] No drives found in manifest");
        return;
    }
    const docsByDrive = new Map();
    let totalDocs = 0;
    for (const driveId of driveIds) {
        const dm = await swarmClient.readDriveManifest(driveId);
        if (dm && Object.keys(dm.documents).length > 0) {
            swarmDriveNames.set(driveId, dm.name || swarmDriveNames.get(driveId) || "Recovered Drive");
            // Cache so folder info is available for UI population after recovery
            driveManifestCache.set(driveId, dm);
            console.log(`[SwarmPlugin] Drive manifest found for "${dm.name}" (${driveId.slice(0, 8)}, ${Object.keys(dm.documents).length} docs)`);
            const docs = [];
            for (const [docId, docEntry] of Object.entries(dm.documents)) {
                // Skip if already exists locally
                if (localDocIds.has(docId))
                    continue;
                try {
                    await reactorClient.get(docId);
                    continue;
                }
                catch { /* doesn't exist */ }
                docs.push([docId, docEntry]);
            }
            if (docs.length > 0) {
                docsByDrive.set(driveId, docs);
                totalDocs += docs.length;
            }
        }
    }
    if (totalDocs === 0) {
        console.log("[SwarmPlugin] All documents already exist locally");
        return;
    }
    console.log(`[SwarmPlugin] Recovering ${totalDocs} documents from Swarm`);
    // Map: swarmDriveId → localDriveId (created below)
    const driveIdMap = new Map();
    // Check for existing local drives — if they already exist (HMR re-run), reuse them
    try {
        const existing = await reactorClient.getDrives();
        const existingIds = (existing ?? []).map((d) => d?.id ?? d);
        if (existingIds.length >= docsByDrive.size) {
            // Drives already exist locally — map Swarm drives to existing drives in order
            const swarmDriveIds = [...docsByDrive.keys()];
            for (let i = 0; i < swarmDriveIds.length; i++) {
                if (i < existingIds.length) {
                    driveIdMap.set(swarmDriveIds[i], existingIds[i]);
                    console.log(`[SwarmPlugin] Reusing existing drive ${existingIds[i]?.slice(0, 8)} for ${swarmDriveIds[i].slice(0, 8)}`);
                }
            }
        }
    }
    catch { /* no drives */ }
    // Create local drives for each Swarm drive that doesn't have a local mapping
    syncPaused = true;
    for (const [swarmDriveId] of docsByDrive) {
        if (driveIdMap.has(swarmDriveId))
            continue;
        const driveName = swarmDriveNames.get(swarmDriveId) || "Recovered Drive";
        const cachedDm = driveManifestCache.get(swarmDriveId);
        const preferredEditor = cachedDm?.preferredEditor;
        try {
            const d = await addDrive({ global: { name: driveName } }, preferredEditor);
            const localId = d?.header?.id;
            if (localId) {
                driveIdMap.set(swarmDriveId, localId);
                console.log(`[SwarmPlugin] Created drive "${driveName}" (${localId.slice(0, 8)}) for Swarm drive ${swarmDriveId.slice(0, 8)}${preferredEditor ? ` [editor: ${preferredEditor}]` : ""}`);
            }
            await new Promise((r) => setTimeout(r, 500));
        }
        catch (err) {
            console.warn(`[SwarmPlugin] Failed to create drive "${driveName}":`, err instanceof Error ? err.message : err);
        }
    }
    // Keep syncPaused=true during entire recovery — prevents ensureDriveSynced
    // from re-adding recovery drives to the manifest before clean write
    await new Promise((r) => setTimeout(r, 500));
    // Recover docs into their respective drives
    for (const [swarmDriveId, docsInDrive] of docsByDrive) {
        const localDriveId = driveIdMap.get(swarmDriveId);
        if (!localDriveId) {
            console.warn(`[SwarmPlugin] No local drive for Swarm drive ${swarmDriveId.slice(0, 8)}, skipping ${docsInDrive.length} docs`);
            continue;
        }
        for (const [docId, entry] of docsInDrive) {
            try {
                // Skip if already exists locally
                try {
                    await reactorClient.get(docId);
                    console.log(`[SwarmPlugin] "${entry.name}" already exists, skipping`);
                    continue;
                }
                catch { /* doesn't exist */ }
                const ops = await downloadOperations(swarmClient, docId);
                if (ops.length === 0)
                    continue;
                // Filter to global-scope user ops only.
                // System ops (CREATE_DOCUMENT, UPGRADE_DOCUMENT etc.) use "document" scope.
                // createDocumentInDrive handles those; we only replay user actions (global scope).
                const userOps = ops
                    .filter((op) => op.action.scope === "global")
                    .map((op) => op.action);
                // Get the document model's proper initial state from the reactor
                // (UPGRADE_DOCUMENT on Swarm has empty state — the reactor fills it from the model)
                let initialState = { global: {}, local: {} };
                try {
                    const dmModule = await reactorClient.getDocumentModelModule(entry.documentType);
                    if (dmModule?.utils?.createState) {
                        initialState = dmModule.utils.createState();
                    }
                }
                catch {
                    console.warn(`[SwarmPlugin] Could not get default state for ${entry.documentType}`);
                }
                // Final guard: double-check the doc doesn't exist right before creating
                try {
                    await reactorClient.get(docId);
                    console.log(`[SwarmPlugin] "${entry.name}" exists locally (late check), skipping`);
                    continue;
                }
                catch { /* doesn't exist — proceed */ }
                // Mark as recovering so sync events don't try to write to the feed
                recoveringDocs.add(docId);
                console.log(`[SwarmPlugin] Recovering "${entry.name}" (${docId.slice(0, 8)}..., ${userOps.length} user actions)`);
                const shellDoc = {
                    header: {
                        id: docId,
                        documentType: entry.documentType,
                        name: entry.name || docId,
                        slug: docId,
                        branch: "main",
                        createdAtUtcIso: new Date().toISOString(),
                        lastModifiedAtUtcIso: new Date().toISOString(),
                        revision: { global: 0 },
                        sig: { publicKey: "", nonce: "" },
                    },
                    state: initialState,
                    initialState,
                    operations: { global: [], local: [] },
                };
                await reactorClient.createDocumentInDrive(localDriveId, shellDoc);
                console.log(`[SwarmPlugin] Created "${entry.name}" in drive`);
                // Replay user actions to restore actual document state
                if (userOps.length > 0) {
                    try {
                        await reactorClient.execute(docId, "main", userOps);
                        console.log(`[SwarmPlugin] Restored ${userOps.length} actions for "${entry.name}"`);
                    }
                    catch (err) {
                        console.warn(`[SwarmPlugin] Action replay failed for "${entry.name}":`, err instanceof Error ? err.message : err);
                    }
                }
                // Track recovered doc's drive relationship (so tree view shows it under the drive)
                docToDrive.set(docId, localDriveId);
                // Mark as fully synced and stop skipping sync events
                try {
                    const localOps = await reactorClient.getOperations(docId);
                    syncedRevisions.set(docId, localOps?.results?.length ?? 0);
                }
                catch {
                    // Best effort
                }
                recoveringDocs.delete(docId);
            }
            catch (err) {
                console.warn(`[SwarmPlugin] Recovery failed for "${entry.name}":`, err instanceof Error ? err.message : err);
            }
        } // end docsInDrive loop
    } // end docsByDrive loop
    // ─── Restore folder structure from drive manifests ──────────────
    // Wait for reactor to finish processing all createDocumentInDrive jobs
    await new Promise((r) => setTimeout(r, 2000));
    // The drive manifest stores folder info (populated from drive node tree).
    // We create folders and move docs into them using reactor actions.
    for (const [swarmDriveId, localDriveId] of driveIdMap) {
        try {
            // Ensure drive state is loaded before executing actions
            await reactorClient.get(localDriveId);
            const dm = await swarmClient.readDriveManifest(swarmDriveId);
            if (dm?.folders && Object.keys(dm.folders).length > 0) {
                const actions = [];
                // Create folders in dependency order — parents before children
                const folderEntries = Object.entries(dm.folders);
                const sorted = [];
                const added = new Set();
                const addFolder = (id, folder) => {
                    if (added.has(id))
                        return;
                    // Add parent first if it exists
                    if (folder.parentFolder && dm.folders[folder.parentFolder] && !added.has(folder.parentFolder)) {
                        addFolder(folder.parentFolder, dm.folders[folder.parentFolder]);
                    }
                    sorted.push([id, folder]);
                    added.add(id);
                };
                for (const [id, folder] of folderEntries)
                    addFolder(id, folder);
                for (const [folderId, folder] of sorted) {
                    actions.push({
                        id: crypto.randomUUID(),
                        timestampUtcMs: new Date().toISOString(),
                        type: "ADD_FOLDER",
                        input: {
                            id: folderId,
                            name: folder.name,
                            ...(folder.parentFolder ? { parentFolder: folder.parentFolder } : {}),
                        },
                        scope: "global",
                    });
                }
                // Move docs into their folders
                for (const [docId, docEntry] of Object.entries(dm.documents)) {
                    if (docEntry.parentFolder) {
                        actions.push({
                            id: crypto.randomUUID(),
                            timestampUtcMs: new Date().toISOString(),
                            type: "MOVE_NODE",
                            input: {
                                srcFolder: docId,
                                targetParentFolder: docEntry.parentFolder,
                            },
                            scope: "global",
                        });
                    }
                }
                if (actions.length > 0) {
                    console.log(`[SwarmPlugin] Restoring ${actions.length} folder/move actions for drive ${swarmDriveId.slice(0, 8)}`);
                    // Execute one at a time — reactor needs state to settle between each
                    for (const action of actions) {
                        try {
                            await reactorClient.execute(localDriveId, "main", [action]);
                            await new Promise((r) => setTimeout(r, 200));
                        }
                        catch (err) {
                            console.warn(`[SwarmPlugin] Folder action ${action.type} failed:`, err instanceof Error ? err.message : err);
                        }
                    }
                    console.log(`[SwarmPlugin] Folder structure restored for drive ${swarmDriveId.slice(0, 8)}`);
                }
            }
        }
        catch (err) {
            console.warn(`[SwarmPlugin] Could not restore folders:`, err instanceof Error ? err.message : err);
        }
    }
    // After recovery, write a CLEAN user manifest containing ALL recovered drives and their docs.
    const ownerAddr = ph?.renown?.user?.address;
    if (swarmClient && ownerAddr && driveIdMap.size > 0) {
        const now = new Date().toISOString();
        const cleanDrives = {};
        // Use the ORIGINAL Swarm driveId as the key — NOT the new local driveId.
        // This ensures the next recovery reads from the SAME drive manifest feed
        // that already has the docs, instead of a new empty feed.
        for (const [swarmDriveId] of driveIdMap) {
            cleanDrives[swarmDriveId] = {
                name: swarmDriveNames.get(swarmDriveId) || "Recovered Drive",
                documentIds: [],
                lastUpdated: now,
            };
        }
        const cleanManifest = {
            address: ownerAddr,
            documents: {},
            drives: cleanDrives,
            stamps: {},
            updatedAt: now,
        };
        // Cancel ALL pending flushes — the clean manifest is the source of truth
        if (manifestFlushTimer) {
            clearTimeout(manifestFlushTimer);
            manifestFlushTimer = null;
        }
        pendingManifestDriveUpdates.clear();
        manifestFlushGeneration++; // Invalidate any in-flight flush IIFE
        // Cancel pending document manifest flushes too
        for (const timer of docManifestTimers.values())
            clearTimeout(timer);
        docManifestTimers.clear();
        pendingManifests.clear();
        pendingOps.clear();
        pendingFlushMeta.clear();
        await swarmClient.updateUserManifest(ownerAddr, cleanManifest);
        // Populate UI cache with doc entries from recovered drives
        // (Swarm manifest is slim, but UI reads documents for tree view)
        const uiManifest = { ...cleanManifest, documents: {}, driveManifests: {} };
        for (const [swarmDriveId] of driveIdMap) {
            const driveName = swarmDriveNames.get(swarmDriveId) || "Recovered Drive";
            uiManifest.documents[swarmDriveId] = {
                documentType: "powerhouse/document-drive",
                name: driveName,
                driveId: "",
                lastUpdated: now,
            };
            // Read drive manifest for folder info + parentFolder on docs
            const dm = driveManifestCache.get(swarmDriveId);
            if (dm?.folders && Object.keys(dm.folders).length > 0) {
                uiManifest.driveManifests[swarmDriveId] = { folders: dm.folders };
            }
            const docsInDrive = docsByDrive.get(swarmDriveId) ?? [];
            for (const [docId, entry] of docsInDrive) {
                const parentFolder = dm?.documents?.[docId]?.parentFolder;
                uiManifest.documents[docId] = {
                    documentType: entry.documentType,
                    name: entry.name,
                    driveId: swarmDriveId,
                    parentFolder: parentFolder || undefined,
                    lastUpdated: now,
                };
            }
        }
        if (ph?.swarm) {
            ph.swarm.userManifest = uiManifest;
        }
        console.log(`[SwarmPlugin] Clean manifest written (${driveIdMap.size} drives)`);
    }
    // NOW resume sync — the clean manifest is the source of truth
    syncPaused = false;
    console.log("[SwarmPlugin] Hydration complete");
}
async function downloadOperations(swarmClient, docId) {
    const manifest = await swarmClient.readManifest(docId);
    if (!manifest || manifest.operationBatches.length === 0)
        return [];
    // Download batches in manifest order (append-only log)
    const allOps = [];
    for (const batch of manifest.operationBatches) {
        try {
            const data = await swarmClient.downloadData(batch.reference);
            const ops = JSON.parse(new TextDecoder().decode(data));
            allOps.push(...ops);
        }
        catch (err) {
            console.warn(`[SwarmPlugin] Failed to download batch ${batch.reference.slice(0, 12)}...:`, err instanceof Error ? err.message : err);
        }
    }
    // Deduplicate by operation ID (preferred) or index.
    // Batches are append-only segments — later batches have higher indices.
    // If two batches overlap (from a re-sync bug), keep the first occurrence.
    allOps.sort((a, b) => a.index - b.index);
    const seenIds = new Set();
    const seenIndices = new Set();
    return allOps.filter((op) => {
        // Prefer dedup by op ID (globally unique)
        const opId = op.id ?? op.action?.id;
        if (opId) {
            if (seenIds.has(opId))
                return false;
            seenIds.add(opId);
            return true;
        }
        // Fallback: dedup by index
        if (seenIndices.has(op.index))
            return false;
        seenIndices.add(op.index);
        return true;
    });
}
// ─── Operation Sync ──────────────────────────────────────────────
/** Track last synced operation count per document */
const syncedRevisions = new Map();
/** Track document → drive relationship (populated from child_added events) */
const docToDrive = new Map();
/** Pause sync — set by clearSwarmStorage, cleared by reconnect */
let syncPaused = false;
/** Track total bytes uploaded to Swarm (persists in sessionStorage for display) */
function getUploadedBytes() {
    try {
        return parseInt(sessionStorage.getItem("__swarm_uploaded_bytes__") ?? "0", 10) || 0;
    }
    catch {
        return 0;
    }
}
function addUploadedBytes(bytes) {
    const total = getUploadedBytes() + bytes;
    try {
        sessionStorage.setItem("__swarm_uploaded_bytes__", String(total));
    }
    catch { }
    const ph = globalThis.window?.ph;
    if (ph?.swarm)
        ph.swarm.totalBytesUploaded = total;
}
function resetUploadedBytes() {
    try {
        sessionStorage.removeItem("__swarm_uploaded_bytes__");
    }
    catch { }
}
/** Prevents hydration from running multiple times (HMR resets module state).
 *  Use sessionStorage so it persists across HMR but resets on new tab. */
function getHydrationRan() {
    try {
        return sessionStorage.getItem("__swarm_hydration_ran__") === "1";
    }
    catch {
        return false;
    }
}
function setHydrationRan(val) {
    try {
        if (val)
            sessionStorage.setItem("__swarm_hydration_ran__", "1");
        else
            sessionStorage.removeItem("__swarm_hydration_ran__");
    }
    catch { }
}
let hydrationRan = getHydrationRan();
/** Docs currently being recovered — skip sync events for these to avoid feed conflicts */
const recoveringDocs = new Set();
/** Last drive ID seen by the subscriber — used as fallback for doc→drive resolution
 *  when reactor APIs can't find the relationship (JOB_WRITE_READY failure) */
let lastSeenDriveId = "";
/** Debounce: queue a retry after current sync completes */
const pendingSyncs = new Map();
const needsResync = new Set();
// ─── Phase 1+3: Debounced document manifest writes + op batch accumulation ───
// Instead of writing the document manifest feed on every sync, we:
// 1. Upload ops to /bytes immediately (fast, content-addressed, no conflicts)
// 2. Accumulate manifest changes + pending ops in memory
// 3. Flush to the feed after a 3s debounce (one feed write per burst)
//
// This reduces feed writes from N-per-burst to 1-per-burst, eliminating 400 SOC
// errors from propagation delays. Based on the Swarm "regenerate and publish" pattern.
/** In-memory document manifest cache — written to feed only when debounce fires */
const pendingManifests = new Map();
/** Per-document debounce timers for manifest feed writes */
const docManifestTimers = new Map();
/** Accumulated ops per document — uploaded as one /bytes batch when debounce fires */
const pendingOps = new Map();
/** Metadata needed for the flush (captured during sync) */
const pendingFlushMeta = new Map();
/** How long to wait after the last op before flushing the manifest */
const DOCUMENT_MANIFEST_FLUSH_DELAY_MS = 3000;
/** Max concurrent doc manifest flushes — prevents overloading the Bee node when many docs flush at once */
const MAX_CONCURRENT_FLUSHES = 5;
let activeFlushCount = 0;
const flushQueue = [];
async function startOperationSync(swarmClient, ownerAddress) {
    const ph = globalThis.window?.ph;
    const reactorClient = ph?.reactorClient;
    if (!reactorClient) {
        console.warn("[SwarmPlugin] No reactor client — sync disabled");
        return;
    }
    // Pre-populate drive-doc relationships from current reactor state
    try {
        const drives = await reactorClient.getDrives();
        for (const drive of (drives ?? [])) {
            const driveId = drive?.id ?? drive;
            try {
                const children = await reactorClient.getChildren(driveId);
                const childResults = children?.results ?? children ?? [];
                for (const child of childResults) {
                    const childId = typeof child === "string" ? child : child?.header?.id ?? child?.id;
                    if (childId)
                        docToDrive.set(childId, driveId);
                }
            }
            catch { /* drive not accessible */ }
        }
        if (docToDrive.size > 0) {
            console.log(`[SwarmPlugin] Pre-mapped ${docToDrive.size} docs to drives`);
        }
    }
    catch { /* no drives yet */ }
    reactorClient.subscribe({}, (event) => {
        if (event.type === "deleted")
            return;
        if (syncPaused)
            return;
        const docs = event.documents ?? [];
        for (const doc of docs) {
            const id = doc?.header?.id;
            const docType = doc?.header?.documentType;
            if (!id || !docType)
                continue;
            // Skip docs being recovered
            if (recoveringDocs.has(id))
                continue;
            // Drives: track as lastSeenDriveId for doc→drive resolution fallback.
            // Don't sync here — state.global.name isn't readable during PGlite transaction.
            if (docType === "powerhouse/document-drive") {
                lastSeenDriveId = id;
                setTimeout(() => {
                    ensureDriveSynced(swarmClient, reactorClient, ownerAddress, id).catch(() => { });
                }, 1000);
                continue;
            }
            const name = doc?.header?.name || id;
            if (pendingSyncs.has(id)) {
                needsResync.add(id);
                continue;
            }
            // Resolve driveId from cache or query reactor
            const driveId = docToDrive.get(id) ?? "";
            if (!driveId && docType !== "powerhouse/document-drive") {
                // Async resolve — will update manifest retroactively AND sync the parent drive
                findParentDrive(reactorClient, id).then(async (found) => {
                    if (found) {
                        docToDrive.set(id, found);
                        updateUserManifest(swarmClient, ownerAddress, id, docType, name, found);
                        // Ensure parent drive is also synced (reactor events sometimes fail to fire for drives)
                        await ensureDriveSynced(swarmClient, reactorClient, ownerAddress, found);
                    }
                }).catch(() => { });
            }
            scheduleSync(swarmClient, reactorClient, ownerAddress, id, docType, name, driveId);
        }
    });
    // Listen for document deletions — reactively remove from user manifest
    reactorClient.subscribe({}, (event) => {
        if (event.type !== "deleted" && event.type !== "child_removed")
            return;
        const deletedId = event.context?.childId;
        if (!deletedId)
            return;
        // Remove from local tracking
        docToDrive.delete(deletedId);
        syncedRevisions.delete(deletedId);
        // Remove from user manifest on Swarm (fire-and-forget)
        const ph = globalThis.window?.ph;
        const currentManifest = ph?.swarm?.userManifest;
        if (currentManifest?.documents?.[deletedId]) {
            delete currentManifest.documents[deletedId];
            // Schedule a manifest write with the deletion
            swarmClient.updateUserManifest(ownerAddress, currentManifest).catch(() => { });
            console.log(`[SwarmPlugin] Removed deleted doc ${deletedId.slice(0, 8)}... from manifest`);
        }
    });
    // Reconcile: build manifest from actual reactor state on startup
    // This catches any docs deleted while offline
    reconcileUserManifest(swarmClient, reactorClient, ownerAddress).catch((err) => console.warn("[SwarmPlugin] Reconciliation failed:", err instanceof Error ? err.message : err));
    // Pre-populate docToDrive and driveNames from drive manifests (v2).
    // This ensures drive manifest writes work for ALL docs, not just newly created ones.
    const ph2 = globalThis.window?.ph;
    const cachedManifest = ph2?.swarm?.userManifest;
    const drives = cachedManifest?.drives ?? {};
    for (const [driveId, driveEntry] of Object.entries(drives)) {
        if (driveEntry.name)
            driveNames.set(driveId, driveEntry.name);
        try {
            const dm = await swarmClient.readDriveManifest(driveId);
            if (dm) {
                if (dm.name)
                    driveNames.set(driveId, dm.name);
                for (const docId of Object.keys(dm.documents)) {
                    docToDrive.set(docId, driveId);
                }
            }
        }
        catch { /* drive manifest not available */ }
    }
    // Also populate from UI cache documents (fallback for in-session data)
    if (cachedManifest?.documents) {
        for (const [docId, entry] of Object.entries(cachedManifest.documents)) {
            if (entry.driveId && entry.documentType !== "powerhouse/document-drive" && !docToDrive.has(docId)) {
                docToDrive.set(docId, entry.driveId);
            }
        }
    }
    console.log(`[SwarmPlugin] Pre-populated ${docToDrive.size} doc→drive mappings, ${driveNames.size} drive names`);
    // syncPaused is managed by hydrateFromSwarm — don't reset here to avoid
    // racing with hydration which sets syncPaused = true then false when done.
    console.log("[SwarmPlugin] Operation sync active");
    // Proactively sync all drives. Drive events don't reliably reach our subscriber
    // (the reactor's JOB_WRITE_READY often fails for drive ops), so we sync them
    // explicitly at startup and after every child doc sync.
    syncAllDrives(swarmClient, reactorClient, ownerAddress).catch(() => { });
    // Phase 4: Compact manifests with too many small batches (runs once on startup)
    compactAllManifests(swarmClient, ownerAddress).catch(() => { });
}
async function syncAllDrives(swarmClient, reactorClient, ownerAddress) {
    try {
        const drives = await reactorClient.getDrives();
        for (const drive of (drives ?? [])) {
            const driveId = drive?.id ?? drive;
            await ensureDriveSynced(swarmClient, reactorClient, ownerAddress, driveId);
        }
    }
    catch { /* no drives */ }
}
/**
 * Phase 4: Compact document manifests with too many small batch entries.
 * Runs once on startup. Merges small batches into fewer large ones for faster recovery.
 */
async function compactAllManifests(swarmClient, ownerAddress) {
    const ph = globalThis.window?.ph;
    const userManifest = ph?.swarm?.userManifest;
    if (!userManifest?.documents)
        return;
    for (const [docId, entry] of Object.entries(userManifest.documents)) {
        if (entry.documentType === "powerhouse/document-drive")
            continue;
        try {
            const compacted = await swarmClient.compactManifest?.(docId);
            if (compacted) {
                console.log(`[SwarmPlugin] Compacted manifest for ${docId.slice(0, 8)}...`);
            }
        }
        catch { /* non-critical */ }
    }
}
/**
 * Reconcile the Swarm user manifest with the actual reactor state.
 * Removes entries for docs that no longer exist locally.
 * Runs once on startup to catch deletions that happened while offline.
 */
async function reconcileUserManifest(swarmClient, reactorClient, ownerAddress) {
    const userManifest = await swarmClient.readUserManifest(ownerAddress);
    if (!userManifest || Object.keys(userManifest.documents).length === 0)
        return;
    // Build set of all doc IDs that actually exist in the reactor
    const existingIds = new Set();
    try {
        const drives = await reactorClient.getDrives();
        for (const drive of (drives ?? [])) {
            const driveId = drive?.id ?? drive;
            existingIds.add(driveId);
            try {
                const children = await reactorClient.getChildren(driveId);
                const childResults = children?.results ?? children ?? [];
                for (const child of childResults) {
                    const childId = typeof child === "string" ? child : child?.header?.id ?? child?.id;
                    if (childId)
                        existingIds.add(childId);
                }
            }
            catch { /* no children */ }
        }
    }
    catch { /* reactor not ready */
        return;
    }
    // Remove manifest entries that don't exist in the reactor
    let removed = 0;
    for (const docId of Object.keys(userManifest.documents)) {
        if (!existingIds.has(docId)) {
            delete userManifest.documents[docId];
            removed++;
        }
    }
    if (removed > 0) {
        userManifest.updatedAt = new Date().toISOString();
        await swarmClient.updateUserManifest(ownerAddress, userManifest);
        const ph = globalThis.window?.ph;
        if (ph?.swarm)
            ph.swarm.userManifest = userManifest;
        console.log(`[SwarmPlugin] Reconciled manifest: removed ${removed} stale entries`);
    }
}
/**
 * Find which local drive contains a document.
 *
 * The reactor's indexer often fails to process ADD_RELATIONSHIP because
 * JOB_WRITE_READY consistently fails for ADD_FILE operations. This means
 * both getChildren() and state.global.nodes are unreliable shortly after
 * document creation. However, the ADD_FILE operation IS committed to PGlite.
 *
 * Strategy (in order of reliability):
 * 1. getChildren — works if the indexer processed it
 * 2. Drive operations — scan each drive's ops for ADD_FILE containing docId
 *    (always works because ops are in PGlite even when the event fails)
 */
async function findParentDrive(reactorClient, docId) {
    try {
        const drives = await reactorClient.getDrives();
        if (!drives || drives.length === 0)
            return null;
        // Strategy 1: getChildren (fast path — works if indexer caught up)
        for (const drive of drives) {
            const driveId = drive?.id ?? drive;
            try {
                const children = await reactorClient.getChildren(driveId);
                const childResults = children?.results ?? children ?? [];
                for (const child of childResults) {
                    const childId = typeof child === "string" ? child : child?.header?.id ?? child?.id;
                    if (childId === docId)
                        return driveId;
                }
            }
            catch { /* not accessible */ }
        }
        // Strategy 2: Read drive.state.global.nodes (how Connect does it).
        // Connect accesses drive.state.global.nodes directly — a flat array of
        // {id, name, kind, parentFolder} for all docs/folders in the drive.
        for (const drive of drives) {
            const driveId = drive?.id ?? drive;
            try {
                const driveDoc = await reactorClient.get(driveId);
                const nodes = driveDoc?.state?.global?.nodes;
                if (Array.isArray(nodes)) {
                    for (const node of nodes) {
                        if (node?.id === docId)
                            return driveId;
                    }
                }
            }
            catch { /* not accessible */ }
        }
        // Strategy 3: Use lastSeenDriveId — the most recent drive seen by the subscriber.
        if (lastSeenDriveId)
            return lastSeenDriveId;
        return null;
    }
    catch { /* no drives */ }
    return null;
}
/** Ensure a drive is synced to Swarm — called when a child doc is synced
 *  but the drive itself may have missed its reactor event */
async function ensureDriveSynced(swarmClient, reactorClient, ownerAddress, driveId) {
    // If drive is already being synced, skip
    if (pendingSyncs.has(driveId))
        return;
    let driveName = driveId;
    let preferredEditor;
    try {
        const driveDoc = await reactorClient.get(driveId);
        const name = driveDoc?.state?.global?.name;
        if (name) {
            driveName = name;
            driveNames.set(driveId, name);
        }
        // Read preferredEditor from header.meta
        preferredEditor = driveDoc?.header?.meta?.preferredEditor;
        if (preferredEditor) {
            console.log(`[SwarmPlugin] Drive ${driveId.slice(0, 8)}: preferredEditor = ${preferredEditor}`);
        }
    }
    catch { /* drive not accessible */ }
    // Pre-populate drive manifest cache with preferredEditor so it persists to Swarm
    if (preferredEditor) {
        let cached = driveManifestCache.get(driveId);
        if (!cached) {
            cached = { driveId, name: driveName, documents: {}, updatedAt: new Date().toISOString() };
            driveManifestCache.set(driveId, cached);
        }
        cached.preferredEditor = preferredEditor;
        // Trigger a drive manifest write (even if no child docs yet)
        // Use a dummy entry that flushDriveManifest will pick up via the cache
        setTimeout(() => {
            flushDriveManifest(swarmClient, driveId).catch(() => { });
        }, 2000);
    }
    // Sync drive ops to Swarm (may be 0 ops — but still adds to user manifest)
    scheduleSync(swarmClient, reactorClient, ownerAddress, driveId, "powerhouse/document-drive", driveName, "");
}
function scheduleSync(swarmClient, reactorClient, ownerAddress, id, docType, name, driveId = "") {
    const promise = syncDocumentToSwarm(swarmClient, reactorClient, ownerAddress, id, docType, name, driveId)
        .catch((err) => console.warn(`[SwarmPlugin] Sync failed for ${id.slice(0, 8)}...:`, err instanceof Error ? err.message : err))
        .finally(() => {
        pendingSyncs.delete(id);
        // If changes came in during sync, re-sync now
        if (needsResync.has(id)) {
            needsResync.delete(id);
            scheduleSync(swarmClient, reactorClient, ownerAddress, id, docType, name);
        }
    });
    pendingSyncs.set(id, promise);
}
/**
 * Sync a document's operations to Swarm.
 *
 * Phase 1+3 architecture: instead of writing the manifest feed on every call,
 * we accumulate ops in memory and debounce the feed write. This means:
 * - Ops are gathered from the reactor (fast, local)
 * - They're buffered in `pendingOps` (no network call)
 * - The manifest is updated in memory (`pendingManifests`)
 * - A 3s debounce timer is reset
 * - When the timer fires, `flushDocumentManifest` uploads all accumulated ops
 *   as ONE /bytes batch and writes the manifest to the feed ONCE.
 *
 * Result: 50 rapid edits → 1 /bytes upload + 1 feed write (not 50+50).
 */
async function syncDocumentToSwarm(swarmClient, reactorClient, ownerAddress, docId, docType, docName, driveId = "") {
    // For drives, header.name is always empty — read the real name from state.global.name.
    if (docType === "powerhouse/document-drive" && (!docName || docName === docId)) {
        try {
            const driveDoc = await reactorClient.get(docId);
            const realName = driveDoc?.state?.global?.name;
            if (realName)
                docName = realName;
        }
        catch { /* use whatever name was passed */ }
    }
    // For child docs with no driveId, try to resolve it now
    if (docType !== "powerhouse/document-drive" && !driveId) {
        driveId = docToDrive.get(docId) ?? "";
        if (!driveId) {
            const found = await findParentDrive(reactorClient, docId);
            if (found) {
                driveId = found;
                docToDrive.set(docId, found);
            }
        }
    }
    // Read manifest from in-memory cache first, then fall back to Swarm feed
    let manifest = pendingManifests.get(docId);
    if (!manifest) {
        manifest = (await swarmClient.readManifest(docId)) ?? createEmptyManifest(docId, docType);
    }
    // Determine the highest op index already on Swarm (or pending in memory)
    let swarmLatest = -1;
    for (const rev of Object.values(manifest.latestRevision)) {
        if (typeof rev === "number" && rev > swarmLatest)
            swarmLatest = rev;
    }
    // Also account for ops already accumulated but not yet flushed
    const existing = pendingOps.get(docId);
    if (existing && existing.length > 0) {
        const lastPending = existing[existing.length - 1].index;
        if (lastPending > swarmLatest)
            swarmLatest = lastPending;
    }
    // Get ALL local operations
    const opsResult = await reactorClient.getOperations(docId);
    const allOps = opsResult?.results ?? [];
    // Only accumulate ops that are NOT yet on Swarm or pending
    const newOps = allOps.filter((op) => op.index > swarmLatest);
    if (newOps.length === 0) {
        syncedRevisions.set(docId, allOps.length);
        updateUserManifest(swarmClient, ownerAddress, docId, docType, docName, driveId);
        return;
    }
    // Sort by index to ensure strict sequential order
    newOps.sort((a, b) => a.index - b.index);
    // Accumulate ops in the pending buffer (no /bytes upload yet — that happens at flush)
    const buffer = pendingOps.get(docId) ?? [];
    buffer.push(...newOps);
    pendingOps.set(docId, buffer);
    // Update the manifest's latestRevision in memory (but don't add batch entry yet — flush does that)
    const endIndex = newOps[newOps.length - 1].index;
    manifest.latestRevision["global"] = Math.max(manifest.latestRevision["global"] ?? -1, endIndex);
    manifest.updatedAt = new Date().toISOString();
    pendingManifests.set(docId, manifest);
    // Store metadata needed for flush
    pendingFlushMeta.set(docId, { swarmClient, reactorClient, ownerAddress, docType, docName, driveId });
    syncedRevisions.set(docId, allOps.length);
    setDocSyncStatus(docId, "buffered", buffer.length);
    // Schedule debounced manifest flush — resets on every new op
    const existingTimer = docManifestTimers.get(docId);
    if (existingTimer)
        clearTimeout(existingTimer);
    docManifestTimers.set(docId, setTimeout(() => {
        throttledFlush(docId).catch((err) => console.warn(`[SwarmPlugin] Manifest flush failed for ${docId.slice(0, 8)}...:`, err instanceof Error ? err.message : err));
    }, DOCUMENT_MANIFEST_FLUSH_DELAY_MS));
    // Update user manifest — but only if we have a driveId (for non-drive docs).
    // If driveId is empty, skip now — flushDocumentManifest will re-resolve it and write then.
    // This prevents writing an "unlinked" entry to Swarm that gets read on page reload.
    if (docType === "powerhouse/document-drive" || driveId) {
        updateUserManifest(swarmClient, ownerAddress, docId, docType, docName, driveId);
    }
    console.log(`[SwarmPlugin] Buffered ${newOps.length} ops for "${docName}" (${docId.slice(0, 8)}..., flush in ${DOCUMENT_MANIFEST_FLUSH_DELAY_MS / 1000}s)`);
    // After syncing a child doc, also sync its parent drive.
    if (docType !== "powerhouse/document-drive") {
        const parentDriveId = driveId || docToDrive.get(docId);
        if (parentDriveId) {
            ensureDriveSynced(swarmClient, reactorClient, ownerAddress, parentDriveId).catch(() => { });
        }
        else {
            setTimeout(async () => {
                try {
                    const found = await findParentDrive(reactorClient, docId);
                    if (found) {
                        docToDrive.set(docId, found);
                        updateUserManifest(swarmClient, ownerAddress, docId, docType, docName, found);
                        await ensureDriveSynced(swarmClient, reactorClient, ownerAddress, found);
                    }
                }
                catch { /* best effort */ }
            }, 2000);
        }
    }
}
/**
 * Throttled flush — limits concurrent flushes to MAX_CONCURRENT_FLUSHES.
 * When many docs debounce-fire at the same time (bulk import), this prevents
 * overloading the Bee node with hundreds of simultaneous feed writes.
 */
async function throttledFlush(docId) {
    if (activeFlushCount >= MAX_CONCURRENT_FLUSHES) {
        // Queue for later — will be picked up when an active flush completes
        if (!flushQueue.includes(docId)) {
            flushQueue.push(docId);
        }
        return;
    }
    activeFlushCount++;
    try {
        await flushDocumentManifest(docId);
    }
    finally {
        activeFlushCount--;
        // Process next queued flush
        const next = flushQueue.shift();
        if (next) {
            throttledFlush(next).catch((err) => console.warn(`[SwarmPlugin] Queued flush failed for ${next.slice(0, 8)}:`, err instanceof Error ? err.message : err));
        }
    }
}
/**
 * Flush accumulated ops + manifest for a single document.
 *
 * Called by throttledFlush. Uploads ALL accumulated ops as one /bytes
 * batch, adds one batch entry to the manifest, then writes the manifest to
 * the Swarm feed. This is the only place where a document manifest feed write
 * happens — reducing feed writes from N-per-burst to 1-per-burst.
 */
async function flushDocumentManifest(docId) {
    const meta = pendingFlushMeta.get(docId);
    const manifest = pendingManifests.get(docId);
    const ops = pendingOps.get(docId);
    if (!meta || !manifest)
        return;
    // Take the pending ops and clear the buffer
    pendingOps.delete(docId);
    docManifestTimers.delete(docId);
    const { swarmClient, reactorClient, ownerAddress, docType, docName } = meta;
    // Re-resolve driveId at flush time — the delayed findParentDrive (2s) may have
    // resolved since the ops were buffered, updating docToDrive
    let driveId = meta.driveId || docToDrive.get(docId) || "";
    if (!driveId && docType !== "powerhouse/document-drive") {
        // Try reactor APIs first
        const found = await findParentDrive(reactorClient, docId);
        if (found) {
            driveId = found;
            docToDrive.set(docId, found);
        }
        // Fallback: use the last drive seen by the subscriber.
        // This always works because the drive event fires before the doc event,
        // and it doesn't depend on any reactor API that might fail.
        if (!driveId && lastSeenDriveId) {
            driveId = lastSeenDriveId;
            docToDrive.set(docId, lastSeenDriveId);
        }
    }
    setDocSyncStatus(docId, "flushing", ops?.length ?? 0);
    try {
        if (ops && ops.length > 0) {
            // Upload ALL accumulated ops as ONE /bytes batch
            const payload = JSON.stringify(ops);
            const { reference } = await swarmClient.uploadData(payload);
            addUploadedBytes(payload.length);
            const startIndex = ops[0].index;
            const endIndex = ops[ops.length - 1].index;
            // Add ONE batch entry to the manifest
            manifest.operationBatches.push({
                reference,
                scope: "global",
                branch: "main",
                startIndex,
                endIndex,
                timestamp: new Date().toISOString(),
            });
            console.log(`[SwarmPlugin] Flushing ${ops.length} ops for "${docName}" (${docId.slice(0, 8)}...) → ref:${reference.slice(0, 12)}...`);
        }
        manifest.updatedAt = new Date().toISOString();
        // Write manifest to feed — this is the ONLY feed write per burst
        await swarmClient.updateManifest(docId, manifest);
        // Clear from pending (successfully written)
        pendingManifests.delete(docId);
        pendingFlushMeta.delete(docId);
        // Persist manifest index for recovery after page reload
        await saveManifestIndex(swarmClient.getManifestIndex());
        // Update drive manifest — the doc is listed inside its drive's feed.
        // This is the hierarchical v2 approach: drive feeds are the source of truth
        // for which docs belong to which drive.
        if (driveId && docType !== "powerhouse/document-drive") {
            updateDriveManifest(swarmClient, driveId, docId, docType, docName);
        }
        // Update user manifest with the (now-resolved) driveId (v1 compat + drive metadata)
        updateUserManifest(swarmClient, ownerAddress, docId, docType, docName, driveId);
        setDocSyncStatus(docId, "synced");
        console.log(`[SwarmPlugin] Manifest written for "${docName}" (${docId.slice(0, 8)}...)`);
    }
    catch (err) {
        setDocSyncStatus(docId, "error");
        console.warn(`[SwarmPlugin] Manifest flush failed for ${docId.slice(0, 8)}...:`, err instanceof Error ? err.message : err);
        // Re-queue the ops for next flush attempt
        if (ops && ops.length > 0) {
            const existing = pendingOps.get(docId) ?? [];
            // Prepend failed ops (they have lower indices)
            pendingOps.set(docId, [...ops, ...existing]);
        }
        // Keep manifest in pending — it will be retried on next sync or manual flush
        // Schedule a retry in 5s
        docManifestTimers.set(docId, setTimeout(() => {
            throttledFlush(docId).catch(() => { });
        }, 5000));
    }
}
/**
 * Batched, debounced user manifest writer.
 *
 * Collects document updates in a pending map, then flushes them all in a
 * single feed write after a short debounce. This way 100 rapid document
 * syncs result in 1-2 manifest writes instead of 100 (which would cause
 * feed index conflicts / 400 errors).
 *
 * Inspired by the reactor's job queue pattern — serialize writes, batch
 * pending work, and don't block the sync path.
 */
/** Pending drive updates for user manifest — keyed by driveId */
const pendingManifestDriveUpdates = new Map();
let manifestFlushTimer = null;
let manifestFlushInProgress = null;
/** Incremented on clearStorage — in-flight flushes check this to abort if stale */
let manifestFlushGeneration = 0;
const MANIFEST_FLUSH_DELAY_MS = 3000;
/**
 * v2: Schedule a user manifest update at the DRIVE level.
 * The user manifest only tracks drives (name), not individual docs.
 * Individual docs are tracked in their drive's manifest feed.
 */
function updateUserManifest(swarmClient, ownerAddress, docId, docType, docName, driveId = "") {
    // For drive documents, track the drive itself
    if (docType === "powerhouse/document-drive") {
        pendingManifestDriveUpdates.set(docId, { driveName: docName });
    }
    // For child docs, track the parent drive
    if (driveId) {
        const existing = pendingManifestDriveUpdates.get(driveId);
        pendingManifestDriveUpdates.set(driveId, {
            driveName: existing?.driveName ?? driveNames.get(driveId) ?? driveId,
        });
    }
    // Debounce: wait for rapid-fire syncs to settle, then flush once
    if (manifestFlushTimer)
        clearTimeout(manifestFlushTimer);
    manifestFlushTimer = setTimeout(() => {
        flushUserManifest(swarmClient, ownerAddress);
    }, MANIFEST_FLUSH_DELAY_MS);
}
async function flushUserManifest(swarmClient, ownerAddress) {
    // If a flush is already in progress, wait for it then flush again
    // (new updates may have accumulated)
    if (manifestFlushInProgress) {
        await manifestFlushInProgress;
        if (pendingManifestDriveUpdates.size > 0) {
            return flushUserManifest(swarmClient, ownerAddress);
        }
        return;
    }
    if (pendingManifestDriveUpdates.size === 0)
        return;
    // Take a snapshot of pending updates and clear the queue
    const batch = new Map(pendingManifestDriveUpdates);
    pendingManifestDriveUpdates.clear();
    const generation = manifestFlushGeneration;
    manifestFlushInProgress = (async () => {
        try {
            if (generation !== manifestFlushGeneration)
                return;
            const ph = globalThis.window?.ph;
            const cached = ph?.swarm?.userManifest;
            const userManifest = cached
                ? JSON.parse(JSON.stringify(cached))
                : (await swarmClient.readUserManifest(ownerAddress)) ?? {
                    address: ownerAddress,
                    documents: {},
                    drives: {},
                    stamps: {},
                    updatedAt: new Date().toISOString(),
                };
            if (generation !== manifestFlushGeneration)
                return;
            // v2: Write drive entries, not per-doc entries
            if (!userManifest.drives)
                userManifest.drives = {};
            for (const [driveId, { driveName }] of batch) {
                const cached = driveManifestCache.get(driveId);
                userManifest.drives[driveId] = {
                    name: driveName,
                    documentIds: [],
                    ...(cached?.preferredEditor ? { preferredEditor: cached.preferredEditor } : {}),
                    lastUpdated: new Date().toISOString(),
                };
            }
            userManifest.updatedAt = new Date().toISOString();
            await swarmClient.updateUserManifest(ownerAddress, userManifest);
            if (generation !== manifestFlushGeneration)
                return;
            if (ph?.swarm) {
                // Preserve the UI cache documents (populated from drive manifests)
                // — the slim Swarm manifest has empty documents, but the UI needs them
                const existingDocs = ph.swarm.userManifest?.documents ?? {};
                ph.swarm.userManifest = { ...userManifest, documents: existingDocs };
            }
            console.log(`[SwarmPlugin] User manifest updated (${batch.size} drives)`);
        }
        catch (err) {
            console.warn("[SwarmPlugin] User manifest flush failed:", err instanceof Error ? err.message : err);
            // Re-queue failed updates for next flush (only if not cleared)
            if (generation === manifestFlushGeneration) {
                for (const [driveId, entry] of batch) {
                    if (!pendingManifestDriveUpdates.has(driveId)) {
                        pendingManifestDriveUpdates.set(driveId, entry);
                    }
                }
            }
        }
        finally {
            manifestFlushInProgress = null;
        }
    })();
    await manifestFlushInProgress;
}
/**
 * Clear all Swarm storage by writing empty manifests to feeds.
 * Feeds are append-only — we can't delete, but we can overwrite
 * with empty data. The old /bytes data expires when the stamp runs out.
 */
async function clearSwarmStorage(swarmClient, ownerAddress) {
    // Stop all syncing immediately — prevents re-adding docs after clear
    syncPaused = true;
    // Cancel any pending user manifest flush — invalidate in-flight writes
    if (manifestFlushTimer) {
        clearTimeout(manifestFlushTimer);
        manifestFlushTimer = null;
    }
    pendingManifestDriveUpdates.clear();
    manifestFlushInProgress = null;
    manifestFlushGeneration++; // Abort any in-flight flush IIFE
    // Read current manifest to get drive list and preserve identity fields
    const currentManifest = await swarmClient.readUserManifest(ownerAddress);
    // Clear each drive manifest feed (write empty doc list)
    if (currentManifest?.drives) {
        for (const driveId of Object.keys(currentManifest.drives)) {
            try {
                await swarmClient.updateDriveManifest(driveId, {
                    driveId,
                    name: "",
                    documents: {},
                    updatedAt: new Date().toISOString(),
                });
            }
            catch { /* best effort */ }
        }
    }
    // Write user manifest: keep identity (address, pubkey, stamps), clear data (drives, docs, shares)
    await swarmClient.updateUserManifest(ownerAddress, {
        address: currentManifest?.address ?? ownerAddress,
        beeNodePublicKey: currentManifest?.beeNodePublicKey,
        documents: {},
        drives: {},
        stamps: currentManifest?.stamps ?? {},
        updatedAt: new Date().toISOString(),
    });
    const ph = globalThis.window?.ph;
    if (ph?.swarm) {
        ph.swarm.userManifest = null;
        ph.swarm.syncStatus = {};
    }
    // Cancel any pending document manifest flushes
    for (const timer of docManifestTimers.values())
        clearTimeout(timer);
    docManifestTimers.clear();
    pendingManifests.clear();
    pendingOps.clear();
    pendingFlushMeta.clear();
    // Cancel pending drive manifest flushes
    for (const timer of driveManifestTimers.values())
        clearTimeout(timer);
    driveManifestTimers.clear();
    pendingDriveUpdates.clear();
    driveNames.clear();
    driveManifestCache.clear();
    // Reset all sync state
    syncedRevisions.clear();
    docToDrive.clear();
    pendingSyncs.clear();
    needsResync.clear();
    // Allow hydration to re-run after reconnect (recovery from fresh Swarm state)
    hydrationRan = false;
    setHydrationRan(false);
    resetUploadedBytes();
    console.log("[SwarmPlugin] Swarm storage cleared (sync paused — reconnect to resume)");
}
function createEmptyManifest(documentId, documentType) {
    return {
        documentId,
        documentType,
        latestRevision: {},
        operationBatches: [],
        keyframes: [],
        updatedAt: new Date().toISOString(),
    };
}
// ─── Manifest Index Persistence (IndexedDB) ─────────────────────
// Persists the SwarmClient's in-memory manifest index so it survives
// page reloads. On full "Clear site data", this is also lost, but
// with a real bee node (feed mode), feeds replace this entirely.
const MANIFEST_DB = "swarmManifestIndex";
const MANIFEST_STORE = "index";
function openManifestDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(MANIFEST_DB, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(MANIFEST_STORE)) {
                req.result.createObjectStore(MANIFEST_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function saveManifestIndex(index) {
    try {
        const db = await openManifestDB();
        const tx = db.transaction(MANIFEST_STORE, "readwrite");
        const store = tx.objectStore(MANIFEST_STORE);
        store.put(Object.fromEntries(index), "manifestIndex");
        db.close();
    }
    catch {
        // Non-critical — worst case we lose recovery on page reload
    }
}
async function loadManifestIndex() {
    try {
        const db = await openManifestDB();
        return new Promise((resolve) => {
            const tx = db.transaction(MANIFEST_STORE, "readonly");
            const store = tx.objectStore(MANIFEST_STORE);
            const req = store.get("manifestIndex");
            req.onsuccess = () => {
                db.close();
                const data = req.result;
                resolve(data ? new Map(Object.entries(data)) : new Map());
            };
            req.onerror = () => {
                db.close();
                resolve(new Map());
            };
        });
    }
    catch {
        return new Map();
    }
}
// ─── Drive Manifest (hierarchical v2) ────────────────────────────
/**
 * Debounced drive manifest writer.
 * Multiple docs in the same drive flushing at once → one drive manifest write.
 */
const pendingDriveUpdates = new Map();
const driveManifestTimers = new Map();
/** Write lock per driveId — prevents concurrent flushDriveManifest for the same drive */
const driveManifestFlushInProgress = new Map();
const DRIVE_MANIFEST_FLUSH_DELAY_MS = 2000;
/** Track the latest known drive name for each driveId */
const driveNames = new Map();
const driveManifestCache = new Map();
function updateDriveManifest(swarmClient, driveId, docId, docType, docName) {
    if (!pendingDriveUpdates.has(driveId)) {
        pendingDriveUpdates.set(driveId, new Map());
    }
    pendingDriveUpdates.get(driveId).set(docId, { docType, docName });
    // Debounce per drive
    const existing = driveManifestTimers.get(driveId);
    if (existing)
        clearTimeout(existing);
    driveManifestTimers.set(driveId, setTimeout(() => {
        flushDriveManifest(swarmClient, driveId).catch((err) => console.warn(`[SwarmPlugin] Drive manifest flush failed for ${driveId.slice(0, 8)}:`, err instanceof Error ? err.message : err));
    }, DRIVE_MANIFEST_FLUSH_DELAY_MS));
}
async function flushDriveManifest(swarmClient, driveId) {
    // If a flush is already in progress for this drive, wait for it then re-check
    const inFlight = driveManifestFlushInProgress.get(driveId);
    if (inFlight) {
        await inFlight;
        if (pendingDriveUpdates.has(driveId) && pendingDriveUpdates.get(driveId).size > 0) {
            return flushDriveManifest(swarmClient, driveId);
        }
        return;
    }
    const updates = pendingDriveUpdates.get(driveId);
    if (!updates || updates.size === 0)
        return;
    // Take snapshot and clear
    const batch = new Map(updates);
    pendingDriveUpdates.delete(driveId);
    driveManifestTimers.delete(driveId);
    const flushPromise = (async () => {
        try {
            // Use local cache as source of truth — NOT Swarm (avoids stale reads from propagation delays).
            // Only seed from Swarm on first access (cold start).
            let manifest = driveManifestCache.get(driveId);
            if (!manifest) {
                // First access — try reading from Swarm to seed the cache
                const fromSwarm = await swarmClient.readDriveManifest(driveId);
                manifest = fromSwarm ?? {
                    driveId,
                    name: driveNames.get(driveId) ?? driveId,
                    documents: {},
                    updatedAt: new Date().toISOString(),
                };
                driveManifestCache.set(driveId, manifest);
            }
            // Apply updates
            for (const [docId, { docType, docName }] of batch) {
                manifest.documents[docId] = {
                    documentType: docType,
                    name: docName,
                    lastUpdated: new Date().toISOString(),
                };
            }
            manifest.updatedAt = new Date().toISOString();
            // Update drive name if we know it
            const knownName = driveNames.get(driveId);
            if (knownName)
                manifest.name = knownName;
            // Populate folder info + preferredEditor from drive's state (best effort)
            try {
                const ph = globalThis.window?.ph;
                const rc = ph?.reactorClient;
                if (rc) {
                    const driveDoc = await rc.get(driveId);
                    // Store preferredEditor for custom drive types
                    const editor = driveDoc?.header?.meta?.preferredEditor;
                    if (editor) {
                        manifest.preferredEditor = editor;
                    }
                    // Debug: log header meta to verify preferredEditor is stored
                    if (driveDoc?.header?.meta) {
                        console.log(`[SwarmPlugin] Drive ${driveId.slice(0, 8)}: meta =`, JSON.stringify(driveDoc.header.meta));
                    }
                    const nodes = driveDoc?.state?.global?.nodes ?? [];
                    if (nodes.length > 0) {
                        const folders = {};
                        let folderCount = 0;
                        for (const node of nodes) {
                            if (node.kind === "folder" && node.id) {
                                folders[node.id] = {
                                    name: node.name ?? node.id,
                                    parentFolder: node.parentFolder || undefined,
                                };
                                folderCount++;
                            }
                            // File node: id IS the documentId in Powerhouse
                            if (node.kind === "file" && node.id && manifest.documents[node.id]) {
                                manifest.documents[node.id].parentFolder = node.parentFolder || undefined;
                            }
                        }
                        if (folderCount > 0) {
                            manifest.folders = folders;
                            console.log(`[SwarmPlugin] Drive ${driveId.slice(0, 8)}: ${folderCount} folder(s) tracked`);
                        }
                    }
                }
            }
            catch { /* best effort — folder info is optional */ }
            await swarmClient.updateDriveManifest(driveId, manifest);
            // Update the local cache (source of truth for next flush)
            driveManifestCache.set(driveId, manifest);
            // Update the in-memory UI cache so Settings tree view shows docs
            // (the Swarm manifest is slim/drives-only, but the UI needs documents)
            const ph = globalThis.window?.ph;
            if (ph?.swarm?.userManifest) {
                if (!ph.swarm.userManifest.documents)
                    ph.swarm.userManifest.documents = {};
                // Add drive entry
                ph.swarm.userManifest.documents[driveId] = {
                    documentType: "powerhouse/document-drive",
                    name: manifest.name,
                    driveId: "",
                    lastUpdated: manifest.updatedAt,
                };
                // Add doc entries under this drive (with parentFolder info)
                for (const [docId, docEntry] of Object.entries(manifest.documents)) {
                    ph.swarm.userManifest.documents[docId] = {
                        documentType: docEntry.documentType,
                        name: docEntry.name,
                        driveId,
                        parentFolder: docEntry.parentFolder || undefined,
                        lastUpdated: docEntry.lastUpdated,
                    };
                }
                // Store folder info for the Settings UI tree
                if (manifest.folders) {
                    if (!ph.swarm.userManifest.driveManifests)
                        ph.swarm.userManifest.driveManifests = {};
                    ph.swarm.userManifest.driveManifests[driveId] = { folders: manifest.folders };
                }
            }
            console.log(`[SwarmPlugin] Drive manifest written for "${manifest.name}" (${driveId.slice(0, 8)}, ${Object.keys(manifest.documents).length} docs)`);
        }
        catch (err) {
            // Re-queue failed updates
            if (!pendingDriveUpdates.has(driveId)) {
                pendingDriveUpdates.set(driveId, new Map());
            }
            for (const [docId, entry] of batch) {
                pendingDriveUpdates.get(driveId).set(docId, entry);
            }
            // Retry in 5s
            driveManifestTimers.set(driveId, setTimeout(() => {
                flushDriveManifest(swarmClient, driveId).catch(() => { });
            }, 5000));
        }
        finally {
            driveManifestFlushInProgress.delete(driveId);
        }
    })();
    driveManifestFlushInProgress.set(driveId, flushPromise);
    await flushPromise;
}
// ─── Public Profile ─────────────────────────────────────────────
async function publishPublicProfile(client, ethAddress, swarmPublicKey) {
    // The signer address is the feed owner — this is what others need to look us up
    const signerAddress = client.getOwnerAddress();
    // Check if profile already exists (avoid unnecessary feed writes)
    const existing = await client.readPublicProfile(signerAddress);
    // Get Bee node public key and overlay
    let beeNodePublicKey = "";
    let overlayAddress = "";
    try {
        const res = await fetch(`${SWARM_BEE_URL}/addresses`);
        const data = (await res.json());
        beeNodePublicKey = data.publicKey ?? "";
        overlayAddress = data.overlay ?? "";
    }
    catch {
        console.warn("[SwarmPlugin] Could not fetch Bee node addresses for profile");
    }
    if (!beeNodePublicKey) {
        console.warn("[SwarmPlugin] No Bee node public key — skipping profile publish");
        return;
    }
    // Skip if profile is up-to-date
    if (existing &&
        existing.beeNodePublicKey === beeNodePublicKey &&
        existing.swarmPublicKey === swarmPublicKey) {
        console.log("[SwarmPlugin] Public profile already up-to-date");
        return;
    }
    const profile = {
        address: signerAddress,
        ethAddress,
        beeNodePublicKey,
        swarmPublicKey: swarmPublicKey ?? undefined,
        overlayAddress: overlayAddress || undefined,
        updatedAt: new Date().toISOString(),
    };
    await client.publishPublicProfile(signerAddress, profile);
    console.log(`[SwarmPlugin] Published public profile (signer: ${signerAddress.slice(0, 10)}...)`);
}
// ─── Document Sharing ───────────────────────────────────────────
async function shareDocumentsWithUser(client, myAddress, docIds, recipientSignerAddress) {
    try {
        if (syncPaused) {
            return { success: false, shared: 0, error: "Please wait for document recovery to finish before sharing." };
        }
        const mySignerAddress = client.getOwnerAddress();
        console.log(`[SwarmPlugin] Sharing ${docIds.length} doc(s) with signer ${recipientSignerAddress.slice(0, 10)}...`);
        // Flush ALL pending docs before sharing — ensure ops are on Swarm
        // (the 3s debounce may not have fired yet for recently edited docs)
        for (const docId of docIds) {
            if (pendingManifests.has(docId) || pendingOps.has(docId)) {
                await flushDocumentManifest(docId);
            }
        }
        // Also flush any drive that contains shared docs
        const drivesToFlush = new Set();
        for (const docId of docIds) {
            const driveId = docToDrive.get(docId);
            if (driveId && pendingDriveUpdates.has(driveId)) {
                drivesToFlush.add(driveId);
            }
        }
        for (const driveId of drivesToFlush) {
            await flushDriveManifest(client, driveId);
        }
        const ph = globalThis.window?.ph;
        const userManifest = ph?.swarm?.userManifest;
        const reactorClient = ph?.reactorClient;
        // Phase C: Group docs by drive, bundle all ops per drive into ONE upload
        const docsByDrive = new Map();
        for (const docId of docIds) {
            try {
                const manifest = await client.readManifest(docId);
                if (!manifest || manifest.operationBatches.length === 0) {
                    console.warn(`[SwarmPlugin] Doc ${docId.slice(0, 8)} has no ops on Swarm, skipping`);
                    continue;
                }
                // Download all op batches
                const allOps = [];
                for (const batch of manifest.operationBatches) {
                    try {
                        const data = await client.downloadData(batch.reference);
                        const ops = JSON.parse(new TextDecoder().decode(data));
                        allOps.push(...(Array.isArray(ops) ? ops : [ops]));
                    }
                    catch (err) {
                        console.warn(`[SwarmPlugin] Failed batch ${batch.reference.slice(0, 8)}:`, err instanceof Error ? err.message : err);
                    }
                }
                if (allOps.length === 0)
                    continue;
                const docEntry = userManifest?.documents?.[docId];
                const driveId = docEntry?.driveId ?? docToDrive.get(docId) ?? "_default";
                if (!docsByDrive.has(driveId))
                    docsByDrive.set(driveId, []);
                docsByDrive.get(driveId).push({
                    docId,
                    ops: allOps,
                    docType: manifest.documentType,
                    docName: docEntry?.name ?? docId,
                });
            }
            catch (err) {
                console.warn(`[SwarmPlugin] Failed to prepare doc ${docId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
            }
        }
        if (docsByDrive.size === 0) {
            return { success: false, shared: 0, error: "No documents could be shared." };
        }
        // Build share entries — ONE bundle per drive
        const shareEntries = [];
        let totalDocs = 0;
        for (const [driveId, docs] of docsByDrive) {
            // Resolve drive name
            let driveName = userManifest?.drives?.[driveId]?.name ?? "";
            if (!driveName || driveName === driveId)
                driveName = driveNames.get(driveId) ?? "";
            if (!driveName || driveName === driveId) {
                try {
                    if (reactorClient && driveId !== "_default") {
                        const driveDoc = await reactorClient.get(driveId);
                        driveName = driveDoc?.state?.global?.name ?? "";
                    }
                }
                catch { /* best effort */ }
            }
            if (!driveName || driveName === driveId)
                driveName = "Shared Drive";
            // Include folder structure from drive manifest (only for docs being shared)
            const sharedDocIds = new Set(docs.map((d) => d.docId));
            let folderInfo;
            const dm = driveManifestCache.get(driveId);
            if (dm?.folders && Object.keys(dm.folders).length > 0) {
                const docFolders = {};
                const usedFolderIds = new Set();
                for (const [docId, docEntry] of Object.entries(dm.documents)) {
                    if (sharedDocIds.has(docId) && docEntry.parentFolder) {
                        docFolders[docId] = docEntry.parentFolder;
                        usedFolderIds.add(docEntry.parentFolder);
                    }
                }
                // Include parent chain for nested folders
                const allFolders = {};
                for (const folderId of usedFolderIds) {
                    let current = folderId;
                    while (current && dm.folders[current] && !allFolders[current]) {
                        allFolders[current] = dm.folders[current];
                        current = dm.folders[current].parentFolder;
                    }
                }
                if (Object.keys(allFolders).length > 0) {
                    folderInfo = { folders: allFolders, docFolders };
                }
            }
            // Bundle ALL docs' ops for this drive into ONE upload
            const cachedDm = driveManifestCache.get(driveId);
            const bundle = {
                documents: docs.map((d) => ({
                    documentId: d.docId,
                    documentType: d.docType,
                    name: d.docName,
                    operations: d.ops,
                })),
                ...(folderInfo ? { folders: folderInfo.folders, docFolders: folderInfo.docFolders } : {}),
                ...(cachedDm?.preferredEditor ? { preferredEditor: cachedDm.preferredEditor } : {}),
            };
            const shareResult = await client.uploadSharedData(JSON.stringify(bundle), mySignerAddress, recipientSignerAddress);
            shareEntries.push({
                driveId,
                driveName,
                reference: shareResult.reference,
                documents: docs.map((d) => ({
                    documentId: d.docId,
                    documentType: d.docType,
                    name: d.docName,
                    operationCount: d.ops.length,
                })),
                sharedAt: new Date().toISOString(),
            });
            totalDocs += docs.length;
            console.log(`[SwarmPlugin] Bundled ${docs.length} doc(s) for drive "${driveName}" (${docs.reduce((s, d) => s + d.ops.length, 0)} total ops)`);
        }
        // Write ONE clean share manifest
        const shareManifest = {
            from: mySignerAddress,
            to: recipientSignerAddress,
            shares: shareEntries,
            createdAt: new Date().toISOString(),
        };
        await client.writeShareManifest(mySignerAddress, recipientSignerAddress, shareManifest);
        console.log(`[SwarmPlugin] Shared ${totalDocs} doc(s) across ${shareEntries.length} drive(s)`);
        return { success: true, shared: totalDocs };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[SwarmPlugin] Share failed:", msg);
        return { success: false, shared: 0, error: msg };
    }
}
async function importFromUser(client, myAddress, senderSignerAddress) {
    try {
        const mySignerAddress = client.getOwnerAddress();
        console.log(`[SwarmPlugin] Importing shared docs from signer ${senderSignerAddress.slice(0, 10)}...`);
        // 1. Read the share manifest from the sender's feed
        const shareManifest = await client.readShareManifest(senderSignerAddress, mySignerAddress);
        if (!shareManifest || shareManifest.shares.length === 0) {
            return {
                success: false,
                imported: [],
                error: "No documents shared with you from this Swarm ID.",
            };
        }
        const imported = [];
        const ph = globalThis.window?.ph;
        const reactorClient = ph?.reactorClient;
        if (!reactorClient) {
            return { success: false, imported: [], error: "Reactor not available." };
        }
        const { addDrive } = await import("@powerhousedao/reactor-browser");
        // Phase C: each share entry is a drive bundle (one reference → multiple docs)
        for (const share of shareManifest.shares) {
            const driveName = share.driveName || "Imported Docs";
            const displayName = `${driveName} (shared)`;
            // Download the drive bundle FIRST (need preferredEditor before creating drive)
            console.log(`[SwarmPlugin] Downloading drive bundle "${driveName}" ref=${share.reference.slice(0, 16)}...`);
            let bundleData = null;
            const retryDelays = [0, 3000, 8000];
            for (let attempt = 0; attempt < retryDelays.length; attempt++) {
                if (attempt > 0) {
                    console.log(`[SwarmPlugin] Retry ${attempt}/2 for drive bundle (waiting for propagation)...`);
                    await new Promise((r) => setTimeout(r, retryDelays[attempt]));
                }
                try {
                    bundleData = await client.downloadSharedData(share.reference, senderSignerAddress, mySignerAddress);
                    break;
                }
                catch (dlErr) {
                    if (attempt === retryDelays.length - 1) {
                        console.warn(`[SwarmPlugin] Failed to download drive bundle "${driveName}":`, dlErr instanceof Error ? dlErr.message : dlErr);
                    }
                }
            }
            if (!bundleData)
                continue;
            // Parse the bundle — { documents, folders?, docFolders?, preferredEditor? }
            const bundleRaw = JSON.parse(new TextDecoder().decode(bundleData));
            if (!bundleRaw.documents) {
                console.warn(`[SwarmPlugin] Stale bundle format for "${driveName}" — ask sender to re-share`);
                continue;
            }
            const docs = bundleRaw.documents;
            const bundleFolders = bundleRaw.folders ?? {};
            const bundlePreferredEditor = bundleRaw.preferredEditor;
            const bundleDocFolders = bundleRaw.docFolders ?? {};
            console.log(`[SwarmPlugin] Downloaded bundle: ${docs.length} doc(s) in "${driveName}"${Object.keys(bundleFolders).length > 0 ? `, ${Object.keys(bundleFolders).length} folder(s)` : ""}${bundlePreferredEditor ? ` (editor: ${bundlePreferredEditor})` : ""}`);
            // Create or reuse local drive for this bundle
            const driveKey = `swarm:importDrive:${senderSignerAddress}:${displayName}`;
            let localDriveId;
            try {
                const cached = sessionStorage.getItem(driveKey);
                if (cached) {
                    await reactorClient.get(cached);
                    localDriveId = cached;
                    console.log(`[SwarmPlugin] Reusing import drive "${displayName}" (${localDriveId.slice(0, 8)})`);
                }
            }
            catch { /* drive doesn't exist, create new */ }
            if (!localDriveId) {
                try {
                    const d = await addDrive({ global: { name: displayName } }, bundlePreferredEditor);
                    localDriveId = d?.header?.id;
                    if (!localDriveId)
                        continue;
                    sessionStorage.setItem(driveKey, localDriveId);
                    console.log(`[SwarmPlugin] Created import drive: ${displayName} (${localDriveId.slice(0, 8)})`);
                    await new Promise((r) => setTimeout(r, 500));
                }
                catch (err) {
                    console.warn(`[SwarmPlugin] Failed to create drive "${displayName}":`, err);
                    continue;
                }
            }
            // Map original docId → new local docId (for folder assignment)
            const origToLocal = new Map();
            // Import each doc from the bundle
            for (const docBundle of docs) {
                const { documentId: origDocId, documentType, name: docName, operations: rawOps } = docBundle;
                const opsArray = Array.isArray(rawOps) ? rawOps : [rawOps];
                // Extract actions from operations (same as hydration)
                const userOps = opsArray
                    .filter((op) => (op.action?.scope ?? op.scope ?? "global") === "global")
                    .map((op) => op.action ?? op);
                console.log(`[SwarmPlugin] Importing "${docName}" (${userOps.length} actions)`);
                try {
                    const docModelModule = await reactorClient.getDocumentModelModule(documentType);
                    if (!docModelModule) {
                        console.warn(`[SwarmPlugin] Unknown doc type: ${documentType}`);
                        continue;
                    }
                    const initialState = docModelModule.utils.createState();
                    const newDocId = crypto.randomUUID();
                    const shellDoc = {
                        header: {
                            id: newDocId,
                            documentType,
                            name: docName || origDocId,
                            slug: newDocId,
                            branch: "main",
                            createdAtUtcIso: new Date().toISOString(),
                            lastModifiedAtUtcIso: new Date().toISOString(),
                            revision: { global: 0 },
                            sig: { publicKey: "", nonce: "" },
                        },
                        state: initialState,
                        initialState,
                        operations: { global: [], local: [] },
                    };
                    recoveringDocs.add(newDocId);
                    try {
                        await reactorClient.createDocumentInDrive(localDriveId, shellDoc);
                        if (userOps.length > 0) {
                            await reactorClient.execute(newDocId, "main", userOps);
                        }
                        imported.push(newDocId);
                        origToLocal.set(origDocId, newDocId);
                        console.log(`[SwarmPlugin] Imported "${docName}" (${userOps.length} ops) → ${newDocId}`);
                    }
                    finally {
                        recoveringDocs.delete(newDocId);
                    }
                }
                catch (err) {
                    console.warn(`[SwarmPlugin] Failed to import "${docName}":`, err instanceof Error ? err.message : err);
                }
            }
            // Restore folder structure if bundle includes folder info
            if (Object.keys(bundleFolders).length > 0 && localDriveId) {
                await new Promise((r) => setTimeout(r, 1000));
                try {
                    await reactorClient.get(localDriveId);
                    const folderActions = [];
                    // Create folders in dependency order — parents before children
                    const sortedFolders = [];
                    const addedFolders = new Set();
                    const addF = (id, f) => {
                        if (addedFolders.has(id))
                            return;
                        if (f.parentFolder && bundleFolders[f.parentFolder] && !addedFolders.has(f.parentFolder)) {
                            addF(f.parentFolder, bundleFolders[f.parentFolder]);
                        }
                        sortedFolders.push([id, f]);
                        addedFolders.add(id);
                    };
                    for (const [id, f] of Object.entries(bundleFolders))
                        addF(id, f);
                    for (const [folderId, folder] of sortedFolders) {
                        folderActions.push({
                            id: crypto.randomUUID(),
                            timestampUtcMs: new Date().toISOString(),
                            type: "ADD_FOLDER",
                            input: {
                                id: folderId,
                                name: folder.name,
                                ...(folder.parentFolder ? { parentFolder: folder.parentFolder } : {}),
                            },
                            scope: "global",
                        });
                    }
                    // Move docs into their folders (using NEW local doc IDs)
                    for (const [origDocId, folderId] of Object.entries(bundleDocFolders)) {
                        const localDocId = origToLocal.get(origDocId);
                        if (localDocId) {
                            folderActions.push({
                                id: crypto.randomUUID(),
                                timestampUtcMs: new Date().toISOString(),
                                type: "MOVE_NODE",
                                input: {
                                    srcFolder: localDocId,
                                    targetParentFolder: folderId,
                                },
                                scope: "global",
                            });
                        }
                    }
                    if (folderActions.length > 0) {
                        console.log(`[SwarmPlugin] Restoring ${folderActions.length} folder/move actions for imported drive`);
                        for (const action of folderActions) {
                            try {
                                await reactorClient.execute(localDriveId, "main", [action]);
                                await new Promise((r) => setTimeout(r, 200));
                            }
                            catch (err) {
                                console.warn(`[SwarmPlugin] Import folder action ${action.type} failed:`, err instanceof Error ? err.message : err);
                            }
                        }
                    }
                }
                catch (err) {
                    console.warn(`[SwarmPlugin] Could not restore import folders:`, err instanceof Error ? err.message : err);
                }
            }
        }
        console.log(`[SwarmPlugin] Import complete: ${imported.length} documents`);
        return { success: true, imported };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[SwarmPlugin] Import failed:", msg);
        return { success: false, imported: [], error: msg };
    }
}
//# sourceMappingURL=swarm-plugin.js.map