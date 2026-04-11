/**
 * Swarm storage utilities.
 *
 * - clearSwarmStorage: wipe all Swarm feeds (Settings UI button)
 * - loadManifestIndex / saveManifestIndex: IndexedDB cache for feed references
 */
import type { SwarmClient } from "../swarm-client.js";

// ═══════════════════════════════════════════════════════════════
// Manifest Index Persistence (IndexedDB)
// ═══════════════════════════════════════════════════════════════

const MANIFEST_DB = "swarmManifestIndex";
const MANIFEST_STORE = "index";

function openManifestDB(): Promise<IDBDatabase> {
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

export async function saveManifestIndex(index: Map<string, string>): Promise<void> {
  try {
    const db = await openManifestDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(MANIFEST_STORE, "readwrite");
      tx.objectStore(MANIFEST_STORE).put(Object.fromEntries(index), "manifestIndex");
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  } catch {
    // Non-critical — worst case we lose recovery on page reload
  }
}

export async function loadManifestIndex(): Promise<Map<string, string>> {
  try {
    const db = await openManifestDB();
    return new Promise((resolve) => {
      const tx = db.transaction(MANIFEST_STORE, "readonly");
      const store = tx.objectStore(MANIFEST_STORE);
      const req = store.get("manifestIndex");
      req.onsuccess = () => {
        db.close();
        const data = req.result as Record<string, string> | undefined;
        resolve(data ? new Map(Object.entries(data)) : new Map());
      };
      req.onerror = () => {
        db.close();
        resolve(new Map());
      };
    });
  } catch {
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
export async function clearSwarmStorage(
  swarmClient: SwarmClient,
  ownerAddress: string,
): Promise<void> {
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
      } catch { /* best effort */ }
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
  const ph = (globalThis as any).window?.ph;
  if (ph?.swarm) {
    ph.swarm.userManifest = null;
    ph.swarm.syncStatus = {};
  }

  console.log("[SwarmPlugin] Swarm storage cleared — reconnecting...");

  // Auto-reconnect so SwarmChannel re-registers drives
  if (ph?.swarm?.reconnect) {
    try {
      await ph.swarm.reconnect();
    } catch (err) {
      console.warn("[SwarmPlugin] Auto-reconnect after clear failed:", err);
    }
  }
}
