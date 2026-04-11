/**
 * Operation sync: reactor → Swarm.
 *
 * Subscribes to reactor document change events and uploads operations
 * to Swarm. Manages drive sync, reconciliation, and manifest compaction.
 */
import type { SwarmClient } from "../swarm-client.js";
import {
  state,
  setDocSyncStatus,
  findParentDrive,
  createEmptyManifest,
  DOCUMENT_MANIFEST_FLUSH_DELAY_MS,
  type ReactorClient,
} from "./state.js";
import { emitSwarmEvent } from "./events.js";
import {
  throttledFlush,
  flushDriveManifest,
  updateUserManifest,
  updateDriveManifest,
} from "./flush.js";
import { savePendingOps, loadAllPendingOps, clearPendingOps, clearPendingOpsFlag, hasPendingOpsFlag } from "./pending-ops-store.js";

// ═══════════════════════════════════════════════════════════════
// Start Sync
// ═══════════════════════════════════════════════════════════════

/**
 * Start syncing reactor operations to Swarm.
 * Returns a cleanup function that unsubscribes all reactor listeners.
 * Must be called on reconnect to prevent duplicate subscribers.
 */
export async function startOperationSync(
  swarmClient: SwarmClient,
  ownerAddress: string,
): Promise<(() => void) | undefined> {
  const ph = (globalThis as any).window?.ph;
  const reactorClient = ph?.reactorClient;
  if (!reactorClient) {
    console.warn("[SwarmPlugin] No reactor client — sync disabled");
    return undefined;
  }

  const unsubscribers: Array<() => void> = [];

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
          if (childId) state.docToDrive.set(childId, driveId);
        }
      } catch { /* drive not accessible */ }
    }
    if (state.docToDrive.size > 0) {
      console.log(`[SwarmPlugin] Pre-mapped ${state.docToDrive.size} docs to drives`);
    }
  } catch { /* no drives yet */ }

  // Subscribe to document changes
  const unsub1 = reactorClient.subscribe(
    {},
    (event: {
      type: string;
      documents?: Array<{ header?: { id?: string; documentType?: string; name?: string } }>;
    }) => {
      if (event.type === "deleted") return;
      if (state.syncPaused) return;

      const docs = event.documents ?? [];
      for (const doc of docs) {
        const id = doc?.header?.id;
        const docType = doc?.header?.documentType;
        if (!id || !docType) continue;

        // Skip docs being recovered
        if (state.recoveringDocs.has(id)) continue;

        // Drives: sync the drive itself AND schedule drive manifest
        if (docType === "powerhouse/document-drive") {
          state.lastSeenDriveId = id;
          const swarmDriveId = state.localToSwarmDrive.get(id) ?? id;
          const driveName = doc?.header?.name || id;
          console.log(`[SwarmPlugin] Drive change: "${driveName}" (${id.slice(0, 8)} → swarm:${swarmDriveId.slice(0, 8)})`);
          // Sync the drive document ops to Swarm
          scheduleSync(swarmClient, reactorClient, ownerAddress, id, docType, driveName, "");
          // Also update the drive manifest (with delay for state to settle)
          setTimeout(() => {
            ensureDriveSynced(swarmClient, reactorClient, ownerAddress, swarmDriveId).catch(() => {});
          }, 2000);
          continue;
        }

        const name = doc?.header?.name || id;

        if (state.pendingSyncs.has(id)) {
          state.needsResync.add(id);
          continue;
        }

        // Resolve driveId from cache or query reactor
        // Map local drive IDs back to Swarm IDs for hydrated drives
        let driveId = state.docToDrive.get(id) ?? "";
        if (driveId) {
          driveId = state.localToSwarmDrive.get(driveId) ?? driveId;
        }
        if (!driveId && docType !== "powerhouse/document-drive") {
          findParentDrive(reactorClient, id).then(async (found) => {
            if (found) {
              const swarmFound = state.localToSwarmDrive.get(found) ?? found;
              state.docToDrive.set(id, swarmFound);
              console.log(`[SwarmPlugin] Resolved drive for "${name}": ${swarmFound.slice(0, 8)}`);
              updateUserManifest(swarmClient, ownerAddress, id, docType, name, swarmFound);
              await ensureDriveSynced(swarmClient, reactorClient, ownerAddress, swarmFound);
            } else {
              // Fallback: use lastSeenDriveId
              if (state.lastSeenDriveId) {
                const fallback = state.localToSwarmDrive.get(state.lastSeenDriveId) ?? state.lastSeenDriveId;
                state.docToDrive.set(id, fallback);
                console.log(`[SwarmPlugin] Using lastSeenDrive fallback for "${name}": ${fallback.slice(0, 8)}`);
                updateUserManifest(swarmClient, ownerAddress, id, docType, name, fallback);
                await ensureDriveSynced(swarmClient, reactorClient, ownerAddress, fallback);
              } else {
                console.warn(`[SwarmPlugin] Could not find drive for "${name}" (${id.slice(0, 8)})`);
              }
            }
          }).catch((err) => {
            console.warn(`[SwarmPlugin] findParentDrive failed for "${name}":`, err instanceof Error ? err.message : err);
          });
        }

        scheduleSync(swarmClient, reactorClient, ownerAddress, id, docType, name, driveId);
      }
    },
  );

  if (typeof unsub1 === "function") unsubscribers.push(unsub1);

  // Listen for document deletions — reactively remove from user manifest
  const unsub2 = reactorClient.subscribe(
    {},
    (event: { type: string; context?: { childId?: string } }) => {
      if (event.type !== "deleted" && event.type !== "child_removed") return;
      const deletedId = event.context?.childId;
      if (!deletedId) return;

      state.docToDrive.delete(deletedId);
      state.syncedRevisions.delete(deletedId);

      const ph = (globalThis as any).window?.ph;
      const currentManifest = ph?.swarm?.userManifest;
      if (currentManifest?.documents?.[deletedId]) {
        delete currentManifest.documents[deletedId];
        swarmClient.updateUserManifest(ownerAddress, currentManifest).catch(() => {});
        console.log(`[SwarmPlugin] Removed deleted doc ${deletedId.slice(0, 8)}... from manifest`);
      }
    },
  );
  if (typeof unsub2 === "function") unsubscribers.push(unsub2);

  // Reconcile: build manifest from actual reactor state on startup
  reconcileUserManifest(swarmClient, reactorClient, ownerAddress).catch((err) =>
    console.warn("[SwarmPlugin] Reconciliation failed:", err instanceof Error ? err.message : err),
  );

  // Pre-populate docToDrive and driveNames from drive manifests (v2)
  const ph2 = (globalThis as any).window?.ph;
  const cachedManifest = ph2?.swarm?.userManifest;
  const drives = cachedManifest?.drives ?? {};
  for (const [driveId, driveEntry] of Object.entries(drives) as Array<[string, any]>) {
    if (driveEntry.name) state.driveNames.set(driveId, driveEntry.name);
    try {
      const dm = await swarmClient.readDriveManifest(driveId);
      if (dm) {
        if (dm.name) state.driveNames.set(driveId, dm.name);
        for (const docId of Object.keys(dm.documents)) {
          state.docToDrive.set(docId, driveId);
        }
      }
    } catch { /* drive manifest not available */ }
  }
  // Also populate from UI cache documents (fallback for in-session data)
  if (cachedManifest?.documents) {
    for (const [docId, entry] of Object.entries(cachedManifest.documents) as Array<[string, any]>) {
      if (entry.driveId && entry.documentType !== "powerhouse/document-drive" && !state.docToDrive.has(docId)) {
        state.docToDrive.set(docId, entry.driveId);
      }
    }
  }
  console.log(`[SwarmPlugin] Pre-populated ${state.docToDrive.size} doc→drive mappings, ${state.driveNames.size} drive names`);

  console.log("[SwarmPlugin] Operation sync active");

  // Replay any pending ops that were persisted to IndexedDB before the last tab close
  replayPersistedPendingOps(swarmClient, ownerAddress).catch((err) =>
    console.warn("[SwarmPlugin] Pending ops replay failed:", err instanceof Error ? err.message : err),
  );

  // Proactively sync all drives
  syncAllDrives(swarmClient, reactorClient, ownerAddress).catch(() => {});

  // Phase 4: Compact manifests with too many small batches (runs once on startup)
  compactAllManifests(swarmClient, ownerAddress).catch(() => {});

  // Return cleanup function that unsubscribes all reactor listeners
  return () => {
    for (const unsub of unsubscribers) {
      try { unsub(); } catch { /* best effort */ }
    }
    unsubscribers.length = 0;
  };
}

// ═══════════════════════════════════════════════════════════════
// Schedule & Execute Sync
// ═══════════════════════════════════════════════════════════════

export function scheduleSync(
  swarmClient: SwarmClient,
  reactorClient: ReactorClient,
  ownerAddress: string,
  id: string,
  docType: string,
  name: string,
  driveId: string = "",
): void {
  const promise = syncDocumentToSwarm(swarmClient, reactorClient, ownerAddress, id, docType, name, driveId)
    .catch((err) =>
      console.warn(
        `[SwarmPlugin] Sync failed for ${id.slice(0, 8)}...:`,
        err instanceof Error ? err.message : err,
      ),
    )
    .finally(() => {
      state.pendingSyncs.delete(id);
      if (state.needsResync.has(id)) {
        state.needsResync.delete(id);
        // Forward driveId from cache so the retry doesn't lose drive context
        const resolvedDriveId = driveId || state.docToDrive.get(id) || "";
        scheduleSync(swarmClient, reactorClient, ownerAddress, id, docType, name, resolvedDriveId);
      }
    });

  state.pendingSyncs.set(id, promise);
}

/**
 * Sync a document's operations to Swarm.
 *
 * Phase 1+3 architecture: instead of writing the manifest feed on every call,
 * we accumulate ops in memory and debounce the feed write. This means:
 * - Ops are gathered from the reactor (fast, local)
 * - They're buffered in pendingOps (no network call)
 * - The manifest is updated in memory (pendingManifests)
 * - A 3s debounce timer is reset
 * - When the timer fires, flushDocumentManifest uploads all accumulated ops
 *   as ONE /bytes batch and writes the manifest to the feed ONCE.
 */
async function syncDocumentToSwarm(
  swarmClient: SwarmClient,
  reactorClient: ReactorClient,
  ownerAddress: string,
  docId: string,
  docType: string,
  docName: string,
  driveId: string = "",
): Promise<void> {
  // For drives, header.name is always empty — read the real name from state
  if (docType === "powerhouse/document-drive" && (!docName || docName === docId)) {
    try {
      const driveDoc = await reactorClient.get(docId);
      const realName = driveDoc?.state?.global?.name;
      if (realName) docName = realName;
    } catch { /* use whatever name was passed */ }
  }

  // For child docs with no driveId, try to resolve it now
  if (docType !== "powerhouse/document-drive" && !driveId) {
    driveId = state.docToDrive.get(docId) ?? "";
    if (!driveId) {
      const found = await findParentDrive(reactorClient, docId);
      if (found) {
        driveId = found;
        state.docToDrive.set(docId, found);
      }
    }
  }

  // Read manifest from in-memory cache first, then fall back to Swarm feed
  let manifest = state.pendingManifests.get(docId);
  if (!manifest) {
    manifest = (await swarmClient.readManifest(docId)) ?? createEmptyManifest(docId, docType);
  }

  // Determine the highest op index already on Swarm (or pending in memory)
  let swarmLatest = -1;
  for (const rev of Object.values(manifest.latestRevision)) {
    if (typeof rev === "number" && rev > swarmLatest) swarmLatest = rev;
  }

  // Also account for ops already accumulated but not yet flushed
  const existing = state.pendingOps.get(docId);
  if (existing && existing.length > 0) {
    const lastPending = existing[existing.length - 1].index;
    if (lastPending > swarmLatest) swarmLatest = lastPending;
  }

  // Get ALL local operations
  const opsResult = await reactorClient.getOperations(docId);
  const allOps: Array<{ index: number; action: unknown; hash?: string; timestampUtcMs?: string; id?: string }> =
    opsResult?.results ?? [];

  // Only accumulate ops that are NOT yet on Swarm or pending
  const newOps = allOps.filter((op) => op.index > swarmLatest);
  if (newOps.length === 0) {
    state.syncedRevisions.set(docId, allOps.length);
    updateUserManifest(swarmClient, ownerAddress, docId, docType, docName, driveId);
    return;
  }

  // Sort by index to ensure strict sequential order
  newOps.sort((a, b) => a.index - b.index);

  // Accumulate ops in the pending buffer + persist to IndexedDB
  const buffer = state.pendingOps.get(docId) ?? [];
  buffer.push(...newOps);
  state.pendingOps.set(docId, buffer);
  savePendingOps(docId, buffer).catch(() => {});

  // Update the manifest's latestRevision in memory
  const endIndex = newOps[newOps.length - 1].index;
  manifest.latestRevision["global"] = Math.max(
    manifest.latestRevision["global"] ?? -1,
    endIndex,
  );
  manifest.updatedAt = new Date().toISOString();
  state.pendingManifests.set(docId, manifest);

  // Store metadata needed for flush
  state.pendingFlushMeta.set(docId, { swarmClient, reactorClient, ownerAddress, docType, docName, driveId });

  state.syncedRevisions.set(docId, allOps.length);
  setDocSyncStatus(docId, "buffered", buffer.length);

  // Schedule debounced manifest flush — resets on every new op
  const existingTimer = state.docManifestTimers.get(docId);
  if (existingTimer) clearTimeout(existingTimer);
  state.docManifestTimers.set(docId, setTimeout(() => {
    throttledFlush(docId).catch((err) =>
      console.warn(`[SwarmPlugin] Manifest flush failed for ${docId.slice(0, 8)}...:`, err instanceof Error ? err.message : err),
    );
  }, DOCUMENT_MANIFEST_FLUSH_DELAY_MS));

  // Update user manifest — but only if we have a driveId
  if (docType === "powerhouse/document-drive" || driveId) {
    updateUserManifest(swarmClient, ownerAddress, docId, docType, docName, driveId);
  }

  emitSwarmEvent("sync:buffered", { docId, docName, pendingOps: buffer.length });
  console.log(
    `[SwarmPlugin] Buffered ${newOps.length} ops for "${docName}" (${docId.slice(0, 8)}..., flush in ${DOCUMENT_MANIFEST_FLUSH_DELAY_MS / 1000}s)`,
  );

  // After syncing a child doc, also sync its parent drive
  if (docType !== "powerhouse/document-drive") {
    const parentDriveId = driveId || state.docToDrive.get(docId);
    if (parentDriveId) {
      ensureDriveSynced(swarmClient, reactorClient, ownerAddress, parentDriveId).catch(() => {});
    } else {
      setTimeout(async () => {
        try {
          const found = await findParentDrive(reactorClient, docId);
          if (found) {
            state.docToDrive.set(docId, found);
            updateUserManifest(swarmClient, ownerAddress, docId, docType, docName, found);
            await ensureDriveSynced(swarmClient, reactorClient, ownerAddress, found);
          }
        } catch { /* best effort */ }
      }, 2000);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Drive Sync
// ═══════════════════════════════════════════════════════════════

/** Ensure a drive is synced to Swarm — called when a child doc is synced
 *  but the drive itself may have missed its reactor event */
export async function ensureDriveSynced(
  swarmClient: SwarmClient,
  reactorClient: ReactorClient,
  ownerAddress: string,
  driveId: string,
): Promise<void> {
  if (state.pendingSyncs.has(driveId)) return;

  // driveId may be a Swarm ID — resolve to local ID for reactor queries
  const localDriveId = state.swarmToLocalDrive.get(driveId) ?? driveId;

  let driveName = driveId;
  let preferredEditor: string | undefined;

  try {
    const driveDoc = await reactorClient.get(localDriveId);
    const name = driveDoc?.state?.global?.name;
    if (name) {
      driveName = name;
      state.driveNames.set(driveId, name);
    }
    preferredEditor = driveDoc?.header?.meta?.preferredEditor;
    if (preferredEditor) {
      console.log(`[SwarmPlugin] Drive ${driveId.slice(0, 8)}: preferredEditor = ${preferredEditor}`);
    }
  } catch { /* drive not accessible */ }

  // Pre-populate drive manifest cache with preferredEditor
  if (preferredEditor) {
    let cached = state.driveManifestCache.get(driveId);
    if (!cached) {
      cached = { driveId, name: driveName, documents: {}, updatedAt: new Date().toISOString() };
      state.driveManifestCache.set(driveId, cached);
    }
    cached.preferredEditor = preferredEditor;
    setTimeout(() => {
      flushDriveManifest(swarmClient, driveId).catch(() => {});
    }, 2000);
  }

  scheduleSync(swarmClient, reactorClient, ownerAddress, driveId, "powerhouse/document-drive", driveName, "");
}

async function syncAllDrives(
  swarmClient: SwarmClient,
  reactorClient: ReactorClient,
  ownerAddress: string,
): Promise<void> {
  try {
    const drives = await reactorClient.getDrives();
    for (const drive of (drives ?? [])) {
      const driveId = drive?.id ?? drive;
      await ensureDriveSynced(swarmClient, reactorClient, ownerAddress, driveId);
    }
  } catch { /* no drives */ }
}

// ═══════════════════════════════════════════════════════════════
// Reconciliation & Compaction
// ═══════════════════════════════════════════════════════════════

/**
 * Reconcile the Swarm user manifest with the actual reactor state.
 * Removes entries for docs that no longer exist locally.
 */
/**
 * Reconcile the UI-cached user manifest with the actual reactor state.
 * Removes entries for docs that no longer exist locally.
 *
 * Uses the UI cache (ph.swarm.userManifest) as source of truth, NOT a direct
 * Swarm read. Changes are flushed through the debounced updateUserManifest
 * pipeline, which serializes writes and prevents race conditions with
 * concurrent flushUserManifest calls.
 */
async function reconcileUserManifest(
  swarmClient: SwarmClient,
  reactorClient: ReactorClient,
  ownerAddress: string,
): Promise<void> {
  const ph = (globalThis as any).window?.ph;
  const userManifest = ph?.swarm?.userManifest;
  if (!userManifest?.documents || Object.keys(userManifest.documents).length === 0) return;

  // Build a complete set of all known IDs: drives + all nodes in drive state
  // (including docs inside nested folders, not just direct children)
  const existingIds = new Set<string>();
  try {
    const drives = await reactorClient.getDrives();
    for (const drive of (drives ?? [])) {
      const driveId = drive?.id ?? drive;
      existingIds.add(driveId);
      try {
        // Strategy 1: read drive.state.global.nodes — includes ALL nested docs/folders
        const driveDoc = await reactorClient.get(driveId);
        const nodes = driveDoc?.state?.global?.nodes ?? [];
        for (const node of nodes) {
          if (node?.id) existingIds.add(node.id);
        }
      } catch {
        // Fallback: getChildren (only direct children)
        try {
          const children = await reactorClient.getChildren(driveId);
          const childResults = children?.results ?? children ?? [];
          for (const child of childResults) {
            const childId = typeof child === "string" ? child : child?.header?.id ?? child?.id;
            if (childId) existingIds.add(childId);
          }
        } catch { /* no children */ }
      }
    }
  } catch { /* reactor not ready */ return; }

  let removed = 0;
  for (const docId of Object.keys(userManifest.documents)) {
    if (!existingIds.has(docId)) {
      delete userManifest.documents[docId];
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[SwarmPlugin] Reconciled manifest: removed ${removed} stale entries`);
    // Trigger a debounced user manifest write — goes through the same pipeline
    // as normal sync, avoiding race conditions with flushUserManifest
    userManifest.updatedAt = new Date().toISOString();
    // Schedule a flush by adding a dummy drive update (the flush reads from the UI cache)
    const drives = userManifest.drives ?? {};
    for (const [driveId, entry] of Object.entries(drives) as Array<[string, any]>) {
      updateUserManifest(swarmClient, ownerAddress, driveId, "powerhouse/document-drive", entry.name ?? driveId, "");
      break; // One trigger is enough — the debounce will flush the full cache
    }
  }
}

/**
 * Phase 4: Compact document manifests with too many small batch entries.
 * Runs once on startup. Merges small batches into fewer large ones.
 */
async function compactAllManifests(
  swarmClient: SwarmClient,
  ownerAddress: string,
): Promise<void> {
  // Only compact docs we OWN (in our drives). Imported/shared docs belong
  // to other users — writing to their feed would fail (wrong signer).
  const ownedDocIds = new Set<string>();
  const ph = (globalThis as any).window?.ph;
  const userManifest = ph?.swarm?.userManifest;
  if (!userManifest?.drives) return;

  // Collect doc IDs from our own drives only
  for (const driveId of Object.keys(userManifest.drives)) {
    const dm = state.driveManifestCache.get(driveId);
    if (dm) {
      for (const docId of Object.keys(dm.documents)) {
        ownedDocIds.add(docId);
      }
    }
  }

  for (const docId of ownedDocIds) {
    try {
      const compacted = await swarmClient.compactManifest(docId);
      if (compacted) {
        console.log(`[SwarmPlugin] Compacted manifest for ${docId.slice(0, 8)}...`);
      }
    } catch { /* non-critical */ }
  }
}

/**
 * Replay pending ops that were persisted to IndexedDB before the last tab close.
 *
 * If the previous session had buffered ops that were never flushed (tab closed,
 * Bee node was down), they survive in IndexedDB. This function loads them back
 * into the in-memory buffer and triggers a flush for each document.
 */
async function replayPersistedPendingOps(
  swarmClient: SwarmClient,
  ownerAddress: string,
): Promise<void> {
  if (!hasPendingOpsFlag(ownerAddress)) return;

  // Load BEFORE clearing the flag — if load fails, flag stays set for next session
  const persisted = await loadAllPendingOps();
  clearPendingOpsFlag(ownerAddress);

  if (persisted.size === 0) return;

  console.log(`[SwarmPlugin] Replaying ${persisted.size} persisted pending op buffers from previous session`);

  for (const [docId, ops] of persisted) {
    if (ops.length === 0) {
      clearPendingOps(docId).catch(() => {});
      continue;
    }

    // Check if these ops are already on Swarm (previous session may have
    // uploaded them but crashed before clearing IndexedDB)
    try {
      const manifest = await swarmClient.readManifest(docId);
      if (manifest) {
        const swarmLatest = Math.max(-1, ...Object.values(manifest.latestRevision));
        const unsynced = ops.filter((op) => op.index > swarmLatest);
        if (unsynced.length === 0) {
          console.log(`[SwarmPlugin] Persisted ops for ${docId.slice(0, 8)}... already on Swarm, skipping`);
          clearPendingOps(docId).catch(() => {});
          continue;
        }
        // Only replay the ops that aren't yet on Swarm
        ops.length = 0;
        ops.push(...unsynced);
      }
    } catch {
      // Manifest read failed (Bee offline?) — replay all ops to be safe
    }

    // Merge with any ops already buffered in this session
    const existing = state.pendingOps.get(docId) ?? [];
    const existingIndices = new Set(existing.map((op) => op.index));
    const newOps = ops.filter((op) => !existingIndices.has(op.index));

    if (newOps.length === 0) {
      clearPendingOps(docId).catch(() => {});
      continue;
    }

    existing.push(...newOps);
    existing.sort((a, b) => a.index - b.index);
    state.pendingOps.set(docId, existing);

    // Trigger flush if metadata is available, otherwise the next
    // syncDocumentToSwarm call picks them up from the buffer
    const meta = state.pendingFlushMeta.get(docId);
    if (meta) {
      throttledFlush(docId).catch((err) =>
        console.warn(`[SwarmPlugin] Replay flush failed for ${docId.slice(0, 8)}:`, err instanceof Error ? err.message : err),
      );
    }

    console.log(`[SwarmPlugin] Restored ${newOps.length} persisted ops for ${docId.slice(0, 8)}...`);
  }
}
