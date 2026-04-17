// ═══════════════════════════════════════════════════════════════
// Manifest Index Persistence (IndexedDB)
// ═══════════════════════════════════════════════════════════════
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
export async function loadManifestIndex() {
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
// ═══════════════════════════════════════════════════════════════
// Clear Storage
// ═══════════════════════════════════════════════════════════════
/**
 * Clear all Swarm storage by writing empty manifests to feeds.
 * Feeds are append-only — we can't delete, but we can overwrite
 * with empty data. The old /bytes data expires when the stamp runs out.
 */
export async function clearSwarmStorage(swarmClient, ownerAddress) {
    // Stop all SwarmChannel instances to prevent them from pushing ops
    // that overwrite the empty manifest we're about to write.
    const phRef = globalThis.window?.ph;
    const sm = phRef?.reactorClientModule?.reactorModule?.syncModule?.syncManager;
    if (sm) {
        try {
            const remotes = sm.list();
            for (const remote of remotes) {
                if (remote.channel?.shutdown) {
                    await remote.channel.shutdown();
                }
            }
            console.log("[SwarmPlugin] Stopped SwarmChannel instances before clearing");
        }
        catch { /* best effort */ }
    }
    let currentManifest = null;
    try {
        currentManifest = await swarmClient.readUserManifest(ownerAddress);
    }
    catch (err) {
        console.warn("[SwarmPlugin] clearSwarmStorage: readUserManifest failed:", err instanceof Error ? err.message : err);
    }
    // Clear each drive manifest feed (best-effort per drive — keep going
    // if one fails, so one bad feed doesn't block clearing the rest).
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
            catch (err) {
                console.warn(`[SwarmPlugin] clearSwarmStorage: clearDriveManifest(${driveId.slice(0, 8)}) failed:`, err instanceof Error ? err.message : err);
            }
        }
    }
    // Write empty user manifest. Try tracked first; if createTag / the
    // tracked write itself 404s (some Bee setups disable or restrict the
    // tag endpoints), retry once without tracking rather than hand a raw
    // axios error to the UI.
    const emptyManifest = {
        address: currentManifest?.address ?? ownerAddress,
        beeNodePublicKey: currentManifest?.beeNodePublicKey,
        documents: {},
        drives: {},
        stamps: currentManifest?.stamps ?? {},
        updatedAt: new Date().toISOString(),
    };
    let tagUid;
    try {
        const result = await swarmClient.updateUserManifest(ownerAddress, emptyManifest, { tracked: true });
        tagUid = result.tagUid;
    }
    catch (err) {
        console.warn("[SwarmPlugin] clearSwarmStorage: tracked updateUserManifest failed, retrying without tracking:", err instanceof Error ? err.message : err);
        await swarmClient.updateUserManifest(ownerAddress, emptyManifest);
    }
    // Tag API is a nice-to-have for propagation confirmation. If it fails
    // (404 on /tags/{uid} — happens on some Bee setups), that's not a
    // reason to fail the whole clear: the manifest has already been
    // written above.
    if (tagUid) {
        console.log("[SwarmPlugin] Waiting for empty manifest data to propagate...");
        try {
            await swarmClient.waitForConfirmation(tagUid, 30_000, 1_000);
            console.log("[SwarmPlugin] Data confirmed — verifying feed pointer...");
        }
        catch (err) {
            console.warn("[SwarmPlugin] Propagation wait skipped:", err instanceof Error ? err.message : err);
        }
    }
    // Clear UI cache
    const ph = globalThis.window?.ph;
    if (ph?.swarm) {
        ph.swarm.userManifest = null;
        ph.swarm.syncStatus = {};
    }
    // Feed SOC propagation on the local Bee node takes 3-30+ seconds.
    // Rather than polling with unreliable cache-bypass, we clear the UI state
    // and tell the user the operation succeeded. A page refresh will always
    // read the latest feed. The empty manifests are written — they just need
    // time to propagate through the Bee node's internal feed index.
    console.log("[SwarmPlugin] Swarm storage cleared. Refresh the page to start fresh.");
}
//# sourceMappingURL=storage.js.map