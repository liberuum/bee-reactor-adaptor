/**
 * Swarm document recovery (hydration).
 *
 * Restores drives, documents, and folder structure from Swarm feeds
 * onto a fresh device. Uses wallet-derived keys for decryption.
 *
 * Also: UI cache population from drive manifests (runs on every manifest
 * load so the Settings tree always has data, even when hydration is skipped).
 */
import type { SwarmClient } from "../swarm-client.js";
import { state, setHydrationRan, registerDriveMapping } from "./state.js";

// ═══════════════════════════════════════════════════════════════
// Folder Structure Restore (shared with sharing)
// ═══════════════════════════════════════════════════════════════

/**
 * Restore folder structure in a local drive from a folder/doc mapping.
 * Sorts folders topologically (parents first), then moves docs into folders.
 * Used by both hydration and import.
 */
export async function restoreFolderStructure(
  reactorClient: any,
  driveId: string,
  folders: Record<string, { name: string; parentFolder?: string }>,
  docMoves: Array<{ docId: string; targetFolder: string }>,
): Promise<void> {
  if (Object.keys(folders).length === 0 && docMoves.length === 0) return;

  const actions: any[] = [];

  // Sort folders topologically — parents before children.
  // Uses a "visiting" set to detect cycles (corrupted/malicious folder data).
  const sorted: Array<[string, { name: string; parentFolder?: string }]> = [];
  const added = new Set<string>();
  const visiting = new Set<string>();
  function addFolder(id: string, folder: { name: string; parentFolder?: string }): void {
    if (added.has(id)) return;
    if (visiting.has(id)) return; // Cycle detected — break the loop
    visiting.add(id);
    if (folder.parentFolder && folders[folder.parentFolder] && !added.has(folder.parentFolder)) {
      addFolder(folder.parentFolder, folders[folder.parentFolder]);
    }
    sorted.push([id, folder]);
    added.add(id);
    visiting.delete(id);
  }
  for (const [id, folder] of Object.entries(folders)) addFolder(id, folder);

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

  for (const { docId, targetFolder } of docMoves) {
    actions.push({
      id: crypto.randomUUID(),
      timestampUtcMs: new Date().toISOString(),
      type: "MOVE_NODE",
      input: { srcFolder: docId, targetParentFolder: targetFolder },
      scope: "global",
    });
  }

  if (actions.length === 0) return;

  console.log(`[SwarmPlugin] Restoring ${actions.length} folder/move actions for drive ${driveId.slice(0, 8)}`);
  // Execute one at a time — reactor needs state to settle between each
  for (const action of actions) {
    try {
      await reactorClient.execute(driveId, "main", [action]);
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.warn(`[SwarmPlugin] Folder action ${action.type} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Populate UI Cache from Drives
// ═══════════════════════════════════════════════════════════════

/**
 * Populate ph.swarm.userManifest.documents from drive manifest feeds.
 * Called on every manifest load (not just recovery) so the Settings UI
 * tree view always has data — even when hydration is skipped.
 */
export async function populateUiCacheFromDrives(
  userManifest: { drives?: Record<string, any>; documents?: Record<string, any> },
): Promise<void> {
  const ph = (globalThis as any).window?.ph;
  const swarmClient = ph?.swarm?.client as SwarmClient | undefined;
  if (!swarmClient || !ph?.swarm) return;

  const drives = userManifest.drives ?? {};
  if (Object.keys(drives).length === 0) return;

  // Build documents map from drive manifests
  const documents: Record<string, any> = {};
  for (const [driveId, driveEntry] of Object.entries(drives) as Array<[string, any]>) {
    documents[driveId] = {
      documentType: "powerhouse/document-drive",
      name: driveEntry.name || driveId,
      driveId: "",
      lastUpdated: driveEntry.lastUpdated || new Date().toISOString(),
    };

    try {
      const dm = await swarmClient.readDriveManifest(driveId);
      if (dm) {
        // Seed the local cache so flushDriveManifest never reads stale data
        state.driveManifestCache.set(driveId, dm);
        for (const [docId, docEntry] of Object.entries(dm.documents) as Array<[string, any]>) {
          documents[docId] = {
            documentType: docEntry.documentType,
            name: docEntry.name,
            driveId,
            parentFolder: docEntry.parentFolder || undefined,
            lastUpdated: docEntry.lastUpdated,
          };
        }
      }
    } catch { /* drive manifest not available yet */ }
  }

  // Populate docToDrive and driveNames from the drive manifests
  for (const [docId, entry] of Object.entries(documents) as Array<[string, any]>) {
    if (entry.driveId && entry.documentType !== "powerhouse/document-drive") {
      state.docToDrive.set(docId, entry.driveId);
    }
    if (entry.documentType === "powerhouse/document-drive" && entry.name) {
      state.driveNames.set(docId, entry.name);
    }
  }
  console.log(`[SwarmPlugin] Populated ${state.docToDrive.size} doc→drive mappings, ${state.driveNames.size} drive names from drive manifests`);

  // Update the UI cache
  if (!ph.swarm.userManifest) {
    ph.swarm.userManifest = { ...userManifest, documents };
  } else {
    ph.swarm.userManifest.documents = { ...ph.swarm.userManifest.documents, ...documents };
  }

  // Store drive manifest folder info for the Settings UI tree
  if (!ph.swarm.userManifest.driveManifests) ph.swarm.userManifest.driveManifests = {};
  for (const [driveId] of Object.entries(drives) as Array<[string, any]>) {
    const cached = state.driveManifestCache.get(driveId);
    if (cached?.folders) {
      ph.swarm.userManifest.driveManifests[driveId] = { folders: cached.folders };
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Hydration (recovery from Swarm)
// ═══════════════════════════════════════════════════════════════

export async function hydrateFromSwarm(
  userManifest: {
    documents?: Record<string, { documentType: string; name: string; driveId?: string }>;
    drives?: Record<string, { name: string; documentIds?: string[]; lastUpdated?: string }>;
  },
): Promise<void> {
  const ph = (globalThis as any).window?.ph;
  const reactorClient = ph?.reactorClient;
  const swarmClient = ph?.swarm?.client as SwarmClient | undefined;
  if (!reactorClient || !swarmClient) {
    console.warn("[SwarmPlugin] Cannot hydrate — missing reactor or swarm client");
    return;
  }

  // Check if hydration already ran — but force it if local has no drives
  if (state.hydrationRan) {
    let localDriveCount = 0;
    try {
      const drives = await reactorClient.getDrives();
      localDriveCount = (drives ?? []).length;
    } catch { /* no drives */ }

    if (localDriveCount > 0) {
      console.log("[SwarmPlugin] Hydration already ran this session, skipping");
      return;
    }
    console.log("[SwarmPlugin] Hydration ran before but no local drives — forcing recovery");
  }
  state.hydrationRan = true;
  setHydrationRan(true);

  // Wait for reactor to fully initialize
  for (let i = 0; i < 20; i++) {
    try {
      const drives = await reactorClient.getDrives();
      if (drives && drives.length > 0) break;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Build set of ALL doc IDs in local reactor (drives + their children)
  const localDocIds = new Set<string>();
  try {
    const drives = await reactorClient.getDrives();
    for (const drive of (drives ?? [])) {
      const driveId = drive?.id ?? drive;
      localDocIds.add(driveId);
      try {
        const driveDoc = await reactorClient.get(driveId);
        const nodes = driveDoc?.state?.global?.nodes ?? [];
        for (const node of nodes) {
          if (node.id) localDocIds.add(node.id);
        }
      } catch { /* drive not accessible */ }
    }
  } catch { /* no drives */ }

  // ─── Recovery: Drive manifests are the source of truth ─────
  const { addDrive } = await import("@powerhousedao/reactor-browser");

  const driveIds: string[] = [];
  const swarmDriveNames = new Map<string, string>();

  if (userManifest.drives && Object.keys(userManifest.drives).length > 0) {
    for (const [driveId, entry] of Object.entries(userManifest.drives)) {
      driveIds.push(driveId);
      swarmDriveNames.set(driveId, entry.name || "Recovered Drive");
    }
  }

  if (driveIds.length === 0) {
    console.log("[SwarmPlugin] No drives found in manifest");
    state.syncPaused = false;
    return;
  }

  // Read drive manifests to discover docs
  type DocEntry = [string, { documentType: string; name: string }];
  const docsByDrive = new Map<string, DocEntry[]>();
  let totalDocs = 0;

  for (const driveId of driveIds) {
    const dm = await swarmClient.readDriveManifest(driveId);
    if (dm && Object.keys(dm.documents).length > 0) {
      swarmDriveNames.set(driveId, dm.name || swarmDriveNames.get(driveId) || "Recovered Drive");
      state.driveManifestCache.set(driveId, dm);
      console.log(`[SwarmPlugin] Drive manifest found for "${dm.name}" (${driveId.slice(0, 8)}, ${Object.keys(dm.documents).length} docs)`);

      const docs: DocEntry[] = [];
      for (const [docId, docEntry] of Object.entries(dm.documents)) {
        if (localDocIds.has(docId)) continue;
        try { await reactorClient.get(docId); continue; } catch { /* doesn't exist */ }
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
    state.syncPaused = false;
    return;
  }

  console.log(`[SwarmPlugin] Recovering ${totalDocs} documents from Swarm`);

  // Map: swarmDriveId → localDriveId (created below)
  const driveIdMap = new Map<string, string>();

  // 1. Check persisted mapping from localStorage (survives page reloads)
  for (const [swarmDriveId] of docsByDrive) {
    const cachedLocal = state.swarmToLocalDrive.get(swarmDriveId);
    if (cachedLocal) {
      driveIdMap.set(swarmDriveId, cachedLocal);
      console.log(`[SwarmPlugin] Drive mapping from cache: ${swarmDriveId.slice(0, 8)} → ${cachedLocal.slice(0, 8)}`);
    }
  }

  // 2. Reuse existing local drives if they match by name
  try {
    const existing = await reactorClient.getDrives();
    for (const drive of (existing ?? [])) {
      const localId = drive?.id ?? drive;
      try {
        const driveDoc = await reactorClient.get(localId);
        const localName = driveDoc?.state?.global?.name;
        if (!localName) continue;
        for (const [swarmDriveId] of docsByDrive) {
          if (driveIdMap.has(swarmDriveId)) continue;
          const swarmName = swarmDriveNames.get(swarmDriveId);
          if (swarmName && swarmName === localName) {
            driveIdMap.set(swarmDriveId, localId);
            registerDriveMapping(localId, swarmDriveId);
            console.log(`[SwarmPlugin] Reusing existing drive "${localName}" (${localId.slice(0, 8)}) for Swarm drive ${swarmDriveId.slice(0, 8)}`);
            break;
          }
        }
      } catch { /* drive not accessible */ }
    }
  } catch { /* no drives */ }

  // Verify cached mappings — if local drive doesn't exist in PGlite, remove stale mapping
  for (const [swarmDriveId] of docsByDrive) {
    if (!driveIdMap.has(swarmDriveId)) continue;
    const cachedLocalId = driveIdMap.get(swarmDriveId)!;
    try {
      await reactorClient.get(cachedLocalId);
      // Drive exists — mapping is valid
    } catch {
      // Drive doesn't exist in PGlite (wiped) — remove stale mapping
      console.log(`[SwarmPlugin] Stale mapping: ${cachedLocalId.slice(0, 8)} no longer exists, will re-create`);
      driveIdMap.delete(swarmDriveId);
    }
  }

  // Create local drives for each Swarm drive that doesn't have a local mapping
  state.syncPaused = true;
  // Signal to the UI that hydration is in progress
  const phHydrate = (globalThis as any).window?.ph;
  if (phHydrate?.swarm) phHydrate.swarm.hydrating = true;
  try {
  for (const [swarmDriveId] of docsByDrive) {
    if (driveIdMap.has(swarmDriveId)) continue;
    const driveName = swarmDriveNames.get(swarmDriveId) || "Recovered Drive";
    const cachedDm = state.driveManifestCache.get(swarmDriveId);
    const preferredEditor = cachedDm?.preferredEditor;
    try {
      const d = await addDrive({ global: { name: driveName } }, preferredEditor);
      const localId = d?.header?.id;
      if (localId) {
        driveIdMap.set(swarmDriveId, localId);
        registerDriveMapping(localId, swarmDriveId);
        console.log(`[SwarmPlugin] Created drive "${driveName}" (${localId.slice(0, 8)}) for Swarm drive ${swarmDriveId.slice(0, 8)}${preferredEditor ? ` [editor: ${preferredEditor}]` : ""}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.warn(`[SwarmPlugin] Failed to create drive "${driveName}":`, err instanceof Error ? err.message : err);
    }
  }
  // Keep syncPaused=true during entire recovery
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
        } catch { /* doesn't exist */ }

        const ops = await downloadOperations(swarmClient, docId);
        if (ops.length === 0) continue;

        const userOps = ops
          .filter((op) => op.action.scope === "global")
          .map((op) => op.action);

        let initialState: any = { global: {}, local: {} };
        try {
          const dmModule = await reactorClient.getDocumentModelModule(entry.documentType);
          if (dmModule?.utils?.createState) {
            initialState = dmModule.utils.createState();
          }
        } catch {
          console.warn(`[SwarmPlugin] Could not get default state for ${entry.documentType}`);
        }

        // Final guard: double-check the doc doesn't exist right before creating
        try {
          await reactorClient.get(docId);
          console.log(`[SwarmPlugin] "${entry.name}" exists locally (late check), skipping`);
          continue;
        } catch { /* doesn't exist — proceed */ }

        state.recoveringDocs.add(docId);

        try {
          console.log(
            `[SwarmPlugin] Recovering "${entry.name}" (${docId.slice(0, 8)}..., ${userOps.length} user actions)`,
          );

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

          if (userOps.length > 0) {
            try {
              await reactorClient.execute(docId, "main", userOps);
              console.log(`[SwarmPlugin] Restored ${userOps.length} actions for "${entry.name}"`);
            } catch (err) {
              console.warn(
                `[SwarmPlugin] Action replay failed for "${entry.name}":`,
                err instanceof Error ? err.message : err,
              );
            }
          }

          state.docToDrive.set(docId, localDriveId!);

          try {
            const localOps = await reactorClient.getOperations(docId);
            state.syncedRevisions.set(docId, localOps?.results?.length ?? 0);
          } catch { /* best effort */ }
        } finally {
          state.recoveringDocs.delete(docId);
        }
      } catch (err) {
        console.warn(
          `[SwarmPlugin] Recovery failed for "${entry.name}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // ─── Restore folder structure from drive manifests ─────────
  await new Promise((r) => setTimeout(r, 2000));
  for (const [swarmDriveId, localDriveId] of driveIdMap) {
    try {
      await reactorClient.get(localDriveId);
      const dm = await swarmClient.readDriveManifest(swarmDriveId);
      if (dm?.folders && Object.keys(dm.folders).length > 0) {
        const docMoves = Object.entries(dm.documents)
          .filter(([_, e]) => e.parentFolder)
          .map(([docId, e]) => ({ docId, targetFolder: e.parentFolder as string }));
        await restoreFolderStructure(reactorClient, localDriveId, dm.folders, docMoves);
        console.log(`[SwarmPlugin] Folder structure restored for drive ${swarmDriveId.slice(0, 8)}`);
      }
    } catch (err) {
      console.warn(`[SwarmPlugin] Could not restore folders:`, err instanceof Error ? err.message : err);
    }
  }

  // After recovery, write a CLEAN user manifest containing ALL recovered drives
  const ownerAddr = ph?.renown?.user?.address;
  if (swarmClient && ownerAddr && driveIdMap.size > 0) {
    const now = new Date().toISOString();
    const cleanDrives: Record<string, { name: string; documentIds: string[]; lastUpdated: string }> = {};

    // Use the ORIGINAL Swarm driveId as the key — NOT the new local driveId
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
    if (state.manifestFlushTimer) {
      clearTimeout(state.manifestFlushTimer);
      state.manifestFlushTimer = null;
    }
    state.pendingManifestDriveUpdates.clear();
    state.manifestFlushGeneration++;

    for (const timer of state.docManifestTimers.values()) clearTimeout(timer);
    state.docManifestTimers.clear();
    state.pendingManifests.clear();
    state.pendingOps.clear();
    state.pendingFlushMeta.clear();

    await swarmClient.updateUserManifest(ownerAddr, cleanManifest);

    // Populate UI cache with doc entries from recovered drives
    const uiManifest = { ...cleanManifest, documents: {} as Record<string, any>, driveManifests: {} as Record<string, any> };
    for (const [swarmDriveId] of driveIdMap) {
      const driveName = swarmDriveNames.get(swarmDriveId) || "Recovered Drive";
      uiManifest.documents[swarmDriveId] = {
        documentType: "powerhouse/document-drive",
        name: driveName,
        driveId: "",
        lastUpdated: now,
      };

      const dm = state.driveManifestCache.get(swarmDriveId);
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

  console.log("[SwarmPlugin] Hydration complete");
  } finally {
    // Always resume sync — even if recovery partially failed
    state.syncPaused = false;
    const phDone = (globalThis as any).window?.ph;
    if (phDone?.swarm) phDone.swarm.hydrating = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Download Operations
// ═══════════════════════════════════════════════════════════════

export async function downloadOperations(
  swarmClient: SwarmClient,
  docId: string,
): Promise<Array<{ index: number; action: { type: string; input: unknown; scope?: string }; id?: string }>> {
  const manifest = await swarmClient.readManifest(docId);
  if (!manifest || manifest.operationBatches.length === 0) return [];

  // Download batches in manifest order (append-only log)
  const allOps: Array<{ index: number; action: { type: string; input: unknown; scope?: string }; id?: string }> = [];
  for (const batch of manifest.operationBatches) {
    try {
      const data = await swarmClient.downloadData(batch.reference);
      const ops = JSON.parse(new TextDecoder().decode(data));
      allOps.push(...ops);
    } catch (err) {
      console.warn(
        `[SwarmPlugin] Failed to download batch ${batch.reference.slice(0, 12)}...:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Deduplicate by operation ID (preferred) or index
  allOps.sort((a, b) => a.index - b.index);
  const seenIds = new Set<string>();
  const seenIndices = new Set<number>();
  return allOps.filter((op) => {
    const opId = op.id ?? (op as any).action?.id;
    if (opId) {
      if (seenIds.has(opId)) return false;
      seenIds.add(opId);
      return true;
    }
    if (seenIndices.has(op.index)) return false;
    seenIndices.add(op.index);
    return true;
  });
}
