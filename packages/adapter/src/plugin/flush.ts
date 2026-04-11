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
import { emitSwarmEvent } from "./events.js";
import {
  state,
  setSwarmStatus,
  setDocSyncStatus,
  addUploadedBytes,
  setHydrationRan,
  resetUploadedBytes,
  findParentDrive,
  MAX_CONCURRENT_FLUSHES,
  MANIFEST_FLUSH_DELAY_MS,
  DRIVE_MANIFEST_FLUSH_DELAY_MS,
  type ReactorClient,
} from "./state.js";

import type { SwarmDriveManifest } from "../types.js";

// ═══════════════════════════════════════════════════════════════
// Drive State Helpers
// ═══════════════════════════════════════════════════════════════

const DRIVE_STATE_TIMEOUT_MS = 5_000;

/**
 * Wait for the reactor's drive state to contain the expected number of files.
 *
 * Uses Promise.allSettled pattern:
 * - Subscribes to reactor change events for the drive
 * - Resolves immediately if state already has enough files
 * - Falls back to best-effort snapshot after timeout (never blocks forever)
 *
 * Returns { driveDoc, nodes, settled } where settled=true means the state
 * had the expected file count.
 */
async function waitForDriveState(
  reactorClient: ReactorClient,
  localDriveId: string,
  expectedDocCount: number,
): Promise<{ driveDoc: any; nodes: any[]; settled: boolean }> {
  // Immediate check — most of the time the state is already settled
  const driveDoc = await reactorClient.get(localDriveId);
  const nodes = driveDoc?.state?.global?.nodes ?? [];
  const fileCount = nodes.filter((n: any) => n.kind === "file").length;

  if (fileCount >= expectedDocCount) {
    return { driveDoc, nodes, settled: true };
  }

  // State not settled — poll with proper cleanup on timeout
  let interval: ReturnType<typeof setInterval> | undefined;
  let unsub: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await new Promise<{ driveDoc: any; nodes: any[]; settled: boolean }>((resolve) => {
      let resolved = false;
      const done = (doc: any, n: any[], settled: boolean) => {
        if (resolved) return;
        resolved = true;
        resolve({ driveDoc: doc, nodes: n, settled });
      };

      const check = async () => {
        try {
          const doc = await reactorClient.get(localDriveId);
          const n = doc?.state?.global?.nodes ?? [];
          if (n.filter((nd: any) => nd.kind === "file").length >= expectedDocCount) {
            done(doc, n, true);
          }
        } catch { /* drive not ready */ }
      };

      // Subscribe to changes if available
      try {
        unsub = reactorClient.subscribe?.(
          { documentId: localDriveId },
          () => { check(); },
        );
      } catch { /* subscribe not available */ }

      // Poll every 500ms as fallback
      interval = setInterval(check, 500);

      // Timeout: resolve with best-effort snapshot
      timer = setTimeout(async () => {
        try {
          const doc = await reactorClient.get(localDriveId);
          const n = doc?.state?.global?.nodes ?? [];
          const settled = n.filter((nd: any) => nd.kind === "file").length >= expectedDocCount;
          done(doc, n, settled);
        } catch {
          done(driveDoc, nodes, false);
        }
      }, DRIVE_STATE_TIMEOUT_MS);
    });

    return result;
  } finally {
    // Always clean up — no leaks regardless of which path resolved
    if (interval) clearInterval(interval);
    if (timer) clearTimeout(timer);
    if (unsub) unsub();
  }
}

/**
 * Apply drive nodes (folders + files) to a drive manifest.
 * Extracts folder hierarchy and parentFolder assignments.
 */
function applyNodesToManifest(
  nodes: any[],
  manifest: SwarmDriveManifest,
  driveId: string,
): void {
  if (nodes.length === 0) return;

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
    if (node.kind === "file" && node.id) {
      // Update parentFolder for docs already in manifest
      if (manifest.documents[node.id]) {
        manifest.documents[node.id].parentFolder = node.parentFolder || undefined;
      } else {
        // Capture files that appeared after the debounce trigger
        manifest.documents[node.id] = {
          documentType: node.documentType ?? "unknown",
          name: node.name ?? node.id,
          parentFolder: node.parentFolder || undefined,
          lastUpdated: new Date().toISOString(),
        };
      }
    }
  }

  if (folderCount > 0) {
    manifest.folders = folders;
  }

  const fileCount = nodes.filter((n: any) => n.kind === "file").length;
  console.log(`[SwarmPlugin] Drive ${driveId.slice(0, 8)}: ${folderCount} folder(s), ${fileCount} file(s) captured`);
}

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

  // Pre-flight: check if stamp is still usable before attempting upload.
  // Without this, an expired stamp causes infinite 5s retry loops.
  try {
    const stampOk = await swarmClient.stamps.getStampStatus();
    if (!stampOk.usable || stampOk.health === "expired") {
      setDocSyncStatus(docId, "error");
      setSwarmStatus("no-stamp", "Postage stamp expired. Buy or top up a stamp to resume syncing.");
      console.warn(`[SwarmPlugin] Stamp expired — flush paused for ${docId.slice(0, 8)}...`);
      // Do NOT retry — user must fix the stamp first. Ops stay in buffer + IndexedDB.
      return;
    }
  } catch {
    // Stamp check failed (Bee unreachable?) — proceed with upload attempt,
    // it will fail and retry naturally
  }

  try {
    // Work on a deep copy of the manifest — partial failure must not corrupt in-memory state
    const manifestCopy = JSON.parse(JSON.stringify(manifest));

    if (opsSnapshot.length > 0) {
      emitSwarmEvent("sync:flushing", { docId, docName, opsCount: opsSnapshot.length });

      const payload = JSON.stringify(opsSnapshot);
      const { reference, tagUid } = await swarmClient.uploadData(payload, { tracked: true, deferred: true });
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

      // Wait for network confirmation (non-blocking for the manifest write)
      if (tagUid) {
        swarmClient.waitForConfirmation(tagUid, 30_000, 2_000).then(
          (result) => {
            emitSwarmEvent("sync:confirmed", {
              docId, docName, opsCount: opsSnapshot.length, reference,
              durationMs: result.durationMs, chunksTotal: result.total, chunksSynced: result.synced,
            });
            console.log(`[SwarmPlugin] Confirmed "${docName}" — ${result.synced}/${result.total} chunks in ${result.durationMs}ms`);
          },
          (err) => {
            console.warn(`[SwarmPlugin] Confirmation timeout for "${docName}":`, err instanceof Error ? err.message : err);
          },
        );
      }
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

    // Check if all pending ops are now flushed
    if (state.pendingOps.size === 0 && state.pendingManifests.size === 0) {
      emitSwarmEvent("sync:all-synced", {});
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    setDocSyncStatus(docId, "error");
    emitSwarmEvent("sync:error", { docId, docName, error: errorMsg });
    console.warn(
      `[SwarmPlugin] Manifest flush failed for ${docId.slice(0, 8)}...:`,
      errorMsg,
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
        // Preserve UI-only fields that don't exist on the Swarm manifest
        const existingDocs = ph.swarm.userManifest?.documents ?? {};
        const existingDriveManifests = ph.swarm.userManifest?.driveManifests ?? {};
        ph.swarm.userManifest = {
          ...userManifest,
          documents: existingDocs,
          driveManifests: existingDriveManifests,
        };
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

      // Populate folder info + preferredEditor from the drive's reactor state.
      // Uses Promise.allSettled pattern: try to read settled state, fall back
      // to best-effort if the reactor hasn't caught up within the timeout.
      try {
        const ph = (globalThis as any).window?.ph;
        const rc = ph?.reactorClient;
        if (rc) {
          const localDriveId = state.swarmToLocalDrive.get(driveId) ?? driveId;
          const expectedDocCount = Object.keys(manifest!.documents).length;

          const { driveDoc, nodes, settled } = await waitForDriveState(
            rc, localDriveId, expectedDocCount,
          );

          if (!settled) {
            console.log(`[SwarmPlugin] Drive ${driveId.slice(0, 8)}: state not fully settled, using best-effort snapshot`);
          }

          if (driveDoc?.header?.meta?.preferredEditor) {
            manifest!.preferredEditor = driveDoc.header.meta.preferredEditor;
          }

          applyNodesToManifest(nodes, manifest!, driveId);
        }
      } catch (err) {
        console.warn(`[SwarmPlugin] Drive ${driveId.slice(0, 8)}: folder capture failed:`, err instanceof Error ? err.message : err);
      }

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
            parentFolder: docEntry.parentFolder || undefined,
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

  // Cancel ALL pending flushes — invalidate in-flight writes
  if (state.manifestFlushTimer) {
    clearTimeout(state.manifestFlushTimer);
    state.manifestFlushTimer = null;
  }
  state.pendingManifestDriveUpdates.clear();
  state.manifestFlushInProgress = null;
  state.manifestFlushGeneration++;

  // Cancel drive manifest flushes
  for (const [, timer] of state.driveManifestTimers) clearTimeout(timer);
  state.driveManifestTimers.clear();
  state.pendingDriveUpdates.clear();
  state.driveManifestFlushInProgress.clear();
  state.driveManifestCache.clear();

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
