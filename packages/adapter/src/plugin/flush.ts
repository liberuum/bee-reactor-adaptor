/**
 * Debounced flush systems for Swarm manifests.
 *
 * Three flush pipelines:
 * - Document manifest: buffers ops → one /bytes upload + one feed write per burst
 * - User manifest: batches drive updates → one feed write per burst
 * - Drive manifest: batches doc entries → one feed write per drive per burst
 *
 * Also: IndexedDB manifest index persistence and clearSwarmStorage.
 */
import type { SwarmClient } from "../swarm-client.js";
import { clearPendingOps, clearAllPendingOps } from "./pending-ops-store.js";
import {
  state,
  setDocSyncStatus,
  addUploadedBytes,
  setHydrationRan,
  resetUploadedBytes,
  findParentDrive,
  MAX_CONCURRENT_FLUSHES,
  MANIFEST_FLUSH_DELAY_MS,
  DRIVE_MANIFEST_FLUSH_DELAY_MS,
} from "./state.js";

// ═══════════════════════════════════════════════════════════════
// Document Manifest Flush
// ═══════════════════════════════════════════════════════════════

/**
 * Throttled flush — limits concurrent flushes to MAX_CONCURRENT_FLUSHES.
 * When many docs debounce-fire at the same time (bulk import), this prevents
 * overloading the Bee node with hundreds of simultaneous feed writes.
 */
export async function throttledFlush(docId: string): Promise<void> {
  if (state.activeFlushCount >= MAX_CONCURRENT_FLUSHES) {
    if (!state.flushQueue.includes(docId)) {
      state.flushQueue.push(docId);
    }
    return;
  }

  state.activeFlushCount++;
  try {
    await flushDocumentManifest(docId);
  } finally {
    state.activeFlushCount--;
    const next = state.flushQueue.shift();
    if (next) {
      throttledFlush(next).catch((err) =>
        console.warn(`[SwarmPlugin] Queued flush failed for ${next.slice(0, 8)}:`, err instanceof Error ? err.message : err),
      );
    }
  }
}

/**
 * Flush accumulated ops + manifest for a single document.
 *
 * Uploads ALL accumulated ops as one /bytes batch, adds one batch entry to
 * the manifest, then writes the manifest to the Swarm feed. This is the only
 * place where a document manifest feed write happens.
 */
export async function flushDocumentManifest(docId: string): Promise<void> {
  const meta = state.pendingFlushMeta.get(docId);
  const manifest = state.pendingManifests.get(docId);
  const ops = state.pendingOps.get(docId);

  if (!meta || !manifest) return;

  // Snapshot ops but do NOT remove from buffer yet — only clear on full success.
  // This prevents duplicate batches if uploadData succeeds but updateManifest fails.
  const opsSnapshot = ops ? [...ops] : [];
  state.docManifestTimers.delete(docId);

  const { swarmClient, reactorClient, ownerAddress, docType, docName } = meta;

  // Re-resolve driveId at flush time
  let driveId = meta.driveId || state.docToDrive.get(docId) || "";
  if (!driveId && docType !== "powerhouse/document-drive") {
    const found = await findParentDrive(reactorClient, docId);
    if (found) {
      driveId = found;
      state.docToDrive.set(docId, found);
    }
    if (!driveId && state.lastSeenDriveId) {
      driveId = state.lastSeenDriveId;
      state.docToDrive.set(docId, state.lastSeenDriveId);
    }
  }
  setDocSyncStatus(docId, "flushing", opsSnapshot.length);

  try {
    // Work on a deep copy of the manifest — partial failure must not corrupt in-memory state
    const manifestCopy = JSON.parse(JSON.stringify(manifest));

    if (opsSnapshot.length > 0) {
      const payload = JSON.stringify(opsSnapshot);
      const { reference } = await swarmClient.uploadData(payload);
      addUploadedBytes(payload.length);

      const startIndex = opsSnapshot[0].index;
      const endIndex = opsSnapshot[opsSnapshot.length - 1].index;

      manifestCopy.operationBatches.push({
        reference,
        scope: "global",
        branch: "main",
        startIndex,
        endIndex,
        timestamp: new Date().toISOString(),
      });

      console.log(
        `[SwarmPlugin] Flushing ${opsSnapshot.length} ops for "${docName}" (${docId.slice(0, 8)}...) → ref:${reference.slice(0, 12)}...`,
      );
    }

    manifestCopy.updatedAt = new Date().toISOString();

    // Write manifest to feed — this is the ONLY feed write per burst
    await swarmClient.updateManifest(docId, manifestCopy);

    // Full success — NOW clear from pending (memory + IndexedDB)
    state.pendingOps.delete(docId);
    state.pendingManifests.delete(docId);
    state.pendingFlushMeta.delete(docId);
    clearPendingOps(docId).catch(() => {});

    // Persist manifest index for recovery after page reload
    await saveManifestIndex(swarmClient.getManifestIndex());

    // Update drive manifest — the doc is listed inside its drive's feed
    if (driveId && docType !== "powerhouse/document-drive") {
      updateDriveManifest(swarmClient, driveId, docId, docType, docName);
    }

    // Update user manifest with the (now-resolved) driveId
    updateUserManifest(swarmClient, ownerAddress, docId, docType, docName, driveId);

    setDocSyncStatus(docId, "synced");
    console.log(
      `[SwarmPlugin] Manifest written for "${docName}" (${docId.slice(0, 8)}...)`,
    );
  } catch (err) {
    setDocSyncStatus(docId, "error");
    console.warn(
      `[SwarmPlugin] Manifest flush failed for ${docId.slice(0, 8)}...:`,
      err instanceof Error ? err.message : err,
    );
    // Ops are still in state.pendingOps (never removed on failure).
    // Schedule a retry in 5s.
    state.docManifestTimers.set(docId, setTimeout(() => {
      throttledFlush(docId).catch(() => {});
    }, 5000));
  }
}

// ═══════════════════════════════════════════════════════════════
// User Manifest Flush
// ═══════════════════════════════════════════════════════════════

/**
 * v2: Schedule a user manifest update at the DRIVE level.
 * The user manifest only tracks drives (name), not individual docs.
 * Individual docs are tracked in their drive's manifest feed.
 */
export function updateUserManifest(
  swarmClient: SwarmClient,
  ownerAddress: string,
  docId: string,
  docType: string,
  docName: string,
  driveId: string = "",
): void {
  // For drive documents, track the drive itself
  if (docType === "powerhouse/document-drive") {
    state.pendingManifestDriveUpdates.set(docId, { driveName: docName });
  }
  // For child docs, track the parent drive
  if (driveId) {
    const existing = state.pendingManifestDriveUpdates.get(driveId);
    state.pendingManifestDriveUpdates.set(driveId, {
      driveName: existing?.driveName ?? state.driveNames.get(driveId) ?? driveId,
    });
  }

  // Debounce: wait for rapid-fire syncs to settle, then flush once
  if (state.manifestFlushTimer) clearTimeout(state.manifestFlushTimer);
  state.manifestFlushTimer = setTimeout(() => {
    flushUserManifest(swarmClient, ownerAddress);
  }, MANIFEST_FLUSH_DELAY_MS);
}

async function flushUserManifest(
  swarmClient: SwarmClient,
  ownerAddress: string,
): Promise<void> {
  // If a flush is already in progress, wait for it then flush again
  if (state.manifestFlushInProgress) {
    await state.manifestFlushInProgress;
    if (state.pendingManifestDriveUpdates.size > 0) {
      return flushUserManifest(swarmClient, ownerAddress);
    }
    return;
  }

  if (state.pendingManifestDriveUpdates.size === 0) return;

  // Take a snapshot of pending updates and clear the queue
  const batch = new Map(state.pendingManifestDriveUpdates);
  state.pendingManifestDriveUpdates.clear();

  const generation = state.manifestFlushGeneration;

  state.manifestFlushInProgress = (async () => {
    try {
      if (generation !== state.manifestFlushGeneration) return;

      const ph = (globalThis as any).window?.ph;
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

      if (generation !== state.manifestFlushGeneration) return;

      // v2: Write drive entries, not per-doc entries
      if (!userManifest.drives) userManifest.drives = {};
      for (const [driveId, { driveName }] of batch) {
        const cachedDm = state.driveManifestCache.get(driveId);
        userManifest.drives[driveId] = {
          name: driveName,
          documentIds: [],
          ...(cachedDm?.preferredEditor ? { preferredEditor: cachedDm.preferredEditor } : {}),
          lastUpdated: new Date().toISOString(),
        };
      }

      userManifest.updatedAt = new Date().toISOString();

      await swarmClient.updateUserManifest(ownerAddress, userManifest);

      if (generation !== state.manifestFlushGeneration) return;

      if (ph?.swarm) {
        // Preserve the UI cache documents (populated from drive manifests)
        const existingDocs = ph.swarm.userManifest?.documents ?? {};
        ph.swarm.userManifest = { ...userManifest, documents: existingDocs };
      }

      console.log(
        `[SwarmPlugin] User manifest updated (${batch.size} drives)`,
      );
    } catch (err) {
      console.warn(
        "[SwarmPlugin] User manifest flush failed:",
        err instanceof Error ? err.message : err,
      );
      // Re-queue failed updates for next flush (only if not cleared)
      if (generation === state.manifestFlushGeneration) {
        for (const [driveId, entry] of batch) {
          if (!state.pendingManifestDriveUpdates.has(driveId)) {
            state.pendingManifestDriveUpdates.set(driveId, entry);
          }
        }
      }
    } finally {
      state.manifestFlushInProgress = null;
    }
  })();

  await state.manifestFlushInProgress;
}

// ═══════════════════════════════════════════════════════════════
// Drive Manifest Flush
// ═══════════════════════════════════════════════════════════════

/**
 * Schedule a drive manifest update. Multiple docs in the same drive
 * flushing at once → one drive manifest write.
 */
export function updateDriveManifest(
  swarmClient: SwarmClient,
  driveId: string,
  docId: string,
  docType: string,
  docName: string,
): void {
  if (!state.pendingDriveUpdates.has(driveId)) {
    state.pendingDriveUpdates.set(driveId, new Map());
  }
  state.pendingDriveUpdates.get(driveId)!.set(docId, { docType, docName });

  // Debounce per drive
  const existing = state.driveManifestTimers.get(driveId);
  if (existing) clearTimeout(existing);
  state.driveManifestTimers.set(driveId, setTimeout(() => {
    flushDriveManifest(swarmClient, driveId).catch((err) =>
      console.warn(`[SwarmPlugin] Drive manifest flush failed for ${driveId.slice(0, 8)}:`, err instanceof Error ? err.message : err),
    );
  }, DRIVE_MANIFEST_FLUSH_DELAY_MS));
}

export async function flushDriveManifest(
  swarmClient: SwarmClient,
  driveId: string,
): Promise<void> {
  // If a flush is already in progress for this drive, wait then re-check
  const inFlight = state.driveManifestFlushInProgress.get(driveId);
  if (inFlight) {
    await inFlight;
    if (state.pendingDriveUpdates.has(driveId) && state.pendingDriveUpdates.get(driveId)!.size > 0) {
      return flushDriveManifest(swarmClient, driveId);
    }
    return;
  }

  const updates = state.pendingDriveUpdates.get(driveId);
  if (!updates || updates.size === 0) return;

  // Take snapshot and clear
  const batch = new Map(updates);
  state.pendingDriveUpdates.delete(driveId);
  state.driveManifestTimers.delete(driveId);

  const flushPromise = (async () => {
    try {
      // Use local cache as source of truth — NOT Swarm (avoids stale reads).
      // Only seed from Swarm on first access (cold start).
      let manifest = state.driveManifestCache.get(driveId);
      if (!manifest) {
        const fromSwarm = await swarmClient.readDriveManifest(driveId);
        manifest = fromSwarm ?? {
          driveId,
          name: state.driveNames.get(driveId) ?? driveId,
          documents: {},
          updatedAt: new Date().toISOString(),
        };
        state.driveManifestCache.set(driveId, manifest);
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
      const knownName = state.driveNames.get(driveId);
      if (knownName) manifest.name = knownName;

      // Populate folder info + preferredEditor from drive's state (best effort)
      try {
        const ph = (globalThis as any).window?.ph;
        const rc = ph?.reactorClient;
        if (rc) {
          const driveDoc = await rc.get(driveId);
          const editor = driveDoc?.header?.meta?.preferredEditor;
          if (editor) {
            manifest!.preferredEditor = editor;
          }
          if (driveDoc?.header?.meta) {
            console.log(`[SwarmPlugin] Drive ${driveId.slice(0, 8)}: meta =`, JSON.stringify(driveDoc.header.meta));
          }
          const nodes = driveDoc?.state?.global?.nodes ?? [];
          if (nodes.length > 0) {
            const folders: Record<string, { name: string; parentFolder?: string }> = {};
            let folderCount = 0;
            for (const node of nodes) {
              if (node.kind === "folder" && node.id) {
                folders[node.id] = {
                  name: node.name ?? node.id,
                  parentFolder: node.parentFolder || undefined,
                };
                folderCount++;
              }
              if (node.kind === "file" && node.id && manifest!.documents[node.id]) {
                manifest!.documents[node.id].parentFolder = node.parentFolder || undefined;
              }
            }
            if (folderCount > 0) {
              manifest!.folders = folders;
              console.log(`[SwarmPlugin] Drive ${driveId.slice(0, 8)}: ${folderCount} folder(s) tracked`);
            }
          }
        }
      } catch { /* best effort — folder info is optional */ }

      await swarmClient.updateDriveManifest(driveId, manifest);
      state.driveManifestCache.set(driveId, manifest);

      // Update the in-memory UI cache so Settings tree view shows docs
      const ph = (globalThis as any).window?.ph;
      if (ph?.swarm?.userManifest) {
        if (!ph.swarm.userManifest.documents) ph.swarm.userManifest.documents = {};
        ph.swarm.userManifest.documents[driveId] = {
          documentType: "powerhouse/document-drive",
          name: manifest.name,
          driveId: "",
          lastUpdated: manifest.updatedAt,
        };
        for (const [docId, docEntry] of Object.entries(manifest.documents)) {
          ph.swarm.userManifest.documents[docId] = {
            documentType: docEntry.documentType,
            name: docEntry.name,
            driveId,
            parentFolder: (docEntry as any).parentFolder || undefined,
            lastUpdated: docEntry.lastUpdated,
          };
        }
        if (manifest.folders) {
          if (!ph.swarm.userManifest.driveManifests) ph.swarm.userManifest.driveManifests = {};
          ph.swarm.userManifest.driveManifests[driveId] = { folders: manifest.folders };
        }
      }

      console.log(`[SwarmPlugin] Drive manifest written for "${manifest.name}" (${driveId.slice(0, 8)}, ${Object.keys(manifest.documents).length} docs)`);
    } catch (err) {
      // Re-queue failed updates
      if (!state.pendingDriveUpdates.has(driveId)) {
        state.pendingDriveUpdates.set(driveId, new Map());
      }
      for (const [docId, entry] of batch) {
        state.pendingDriveUpdates.get(driveId)!.set(docId, entry);
      }
      state.driveManifestTimers.set(driveId, setTimeout(() => {
        flushDriveManifest(swarmClient, driveId).catch(() => {});
      }, 5000));
    } finally {
      state.driveManifestFlushInProgress.delete(driveId);
    }
  })();

  state.driveManifestFlushInProgress.set(driveId, flushPromise);
  await flushPromise;
}

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
  // Stop all syncing immediately
  state.syncPaused = true;

  // Cancel user manifest flush — invalidate in-flight writes
  if (state.manifestFlushTimer) {
    clearTimeout(state.manifestFlushTimer);
    state.manifestFlushTimer = null;
  }
  state.pendingManifestDriveUpdates.clear();
  state.manifestFlushInProgress = null;
  state.manifestFlushGeneration++;

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

  // Write user manifest: keep identity, clear data
  await swarmClient.updateUserManifest(ownerAddress, {
    address: currentManifest?.address ?? ownerAddress,
    beeNodePublicKey: currentManifest?.beeNodePublicKey,
    documents: {},
    drives: {},
    stamps: currentManifest?.stamps ?? {},
    updatedAt: new Date().toISOString(),
  });

  const ph = (globalThis as any).window?.ph;
  if (ph?.swarm) {
    ph.swarm.userManifest = null;
    ph.swarm.syncStatus = {};
  }

  // Cancel pending document manifest flushes
  for (const timer of state.docManifestTimers.values()) clearTimeout(timer);
  state.docManifestTimers.clear();
  state.pendingManifests.clear();
  state.pendingOps.clear();
  state.pendingFlushMeta.clear();
  clearAllPendingOps().catch(() => {});

  // Cancel pending drive manifest flushes
  for (const timer of state.driveManifestTimers.values()) clearTimeout(timer);
  state.driveManifestTimers.clear();
  state.pendingDriveUpdates.clear();
  state.driveNames.clear();
  state.driveManifestCache.clear();

  // Reset all sync state
  state.syncedRevisions.clear();
  state.docToDrive.clear();
  state.pendingSyncs.clear();
  state.needsResync.clear();

  // Allow hydration to re-run after reconnect
  state.hydrationRan = false;
  setHydrationRan(false);
  resetUploadedBytes();

  console.log("[SwarmPlugin] Swarm storage cleared — reconnecting...");

  // Auto-reconnect so new docs/drives get synced to the now-clean Swarm state.
  // Without this, syncPaused stays true forever and nothing syncs.
  if (ph?.swarm?.reconnect) {
    try {
      await ph.swarm.reconnect();
    } catch (err) {
      console.warn("[SwarmPlugin] Auto-reconnect after clear failed:", err);
      // Fallback: at least resume sync so local edits aren't silently lost
      state.syncPaused = false;
    }
  } else {
    // No reconnect available — resume sync directly
    state.syncPaused = false;
  }
}
