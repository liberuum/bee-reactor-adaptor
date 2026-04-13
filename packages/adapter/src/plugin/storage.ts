/**
 * Swarm storage utilities.
 *
 * - clearSwarmStorage: wipe all Swarm feeds (Settings UI button)
 * - loadManifestIndex: IndexedDB cache for feed references
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
  // Stop all SwarmChannel instances to prevent them from pushing ops
  // that overwrite the empty manifest we're about to write.
  const phRef = (globalThis as any).window?.ph;
  const sm = phRef?.reactorClientModule?.reactorModule?.syncModule?.syncManager;
  if (sm) {
    try {
      const remotes = sm.list();
      for (const remote of remotes) {
        if ((remote.channel as any)?.shutdown) {
          await (remote.channel as any).shutdown();
        }
      }
      console.log("[SwarmPlugin] Stopped SwarmChannel instances before clearing");
    } catch { /* best effort */ }
  }

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

  // Write empty user manifest with tracked upload for deterministic confirmation.
  const emptyManifest = {
    address: currentManifest?.address ?? ownerAddress,
    beeNodePublicKey: currentManifest?.beeNodePublicKey,
    documents: {},
    drives: {},
    stamps: currentManifest?.stamps ?? {},
    updatedAt: new Date().toISOString(),
  };
  const { tagUid } = await swarmClient.updateUserManifest(
    ownerAddress,
    emptyManifest as any,
    { tracked: true },
  );

  // Wait for the upload to be confirmed on the network via tag API,
  // then verify the feed reads back the empty manifest.
  if (tagUid) {
    console.log("[SwarmPlugin] Waiting for empty manifest data to propagate...");
    try {
      await swarmClient.waitForConfirmation(tagUid, 30_000, 1_000);
      console.log("[SwarmPlugin] Data confirmed — verifying feed pointer...");
    } catch {
      console.warn("[SwarmPlugin] Data propagation timed out");
    }
  }
  // Verify the feed resolves to empty drives.
  // Feed SOC writes need a short delay before the Bee node serves the new entry.
  console.log("[SwarmPlugin] Waiting for feed SOC to settle...");
  await new Promise((r) => setTimeout(r, 3_000));
  let feedConfirmed = false;
  const verifyStart = Date.now();
  while (Date.now() - verifyStart < 20_000) {
    try {
      const check = await swarmClient.readUserManifest(ownerAddress);
      const driveCount = Object.keys(check?.drives ?? {}).length;
      if (!check || driveCount === 0) {
        console.log("[SwarmPlugin] Empty manifest confirmed on feed");
        feedConfirmed = true;
        break;
      }
      console.log(`[SwarmPlugin] Feed still shows ${driveCount} drive(s), retrying...`);
    } catch {
      console.log("[SwarmPlugin] Feed read failed, retrying...");
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  if (!feedConfirmed) {
    console.warn("[SwarmPlugin] Feed verification timed out — empty manifest may not have propagated");
  }

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
