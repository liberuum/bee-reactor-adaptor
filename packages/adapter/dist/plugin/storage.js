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
    const currentManifest = await swarmClient.readUserManifest(ownerAddress);
    // Clear each drive manifest feed
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
    // Write empty user manifest (keep identity, clear data)
    await swarmClient.updateUserManifest(ownerAddress, {
        address: currentManifest?.address ?? ownerAddress,
        beeNodePublicKey: currentManifest?.beeNodePublicKey,
        documents: {},
        drives: {},
        stamps: currentManifest?.stamps ?? {},
        updatedAt: new Date().toISOString(),
    });
    // Clear UI cache
    const ph = globalThis.window?.ph;
    if (ph?.swarm) {
        ph.swarm.userManifest = null;
        ph.swarm.syncStatus = {};
    }
    console.log("[SwarmPlugin] Swarm storage cleared — reconnecting...");
    // Auto-reconnect so SwarmChannel re-registers drives
    if (ph?.swarm?.reconnect) {
        try {
            await ph.swarm.reconnect();
        }
        catch (err) {
            console.warn("[SwarmPlugin] Auto-reconnect after clear failed:", err);
        }
    }
}
//# sourceMappingURL=storage.js.map