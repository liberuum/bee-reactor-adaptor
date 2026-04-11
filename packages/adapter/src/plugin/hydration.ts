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
import { state, registerDriveMapping, type ReactorClient } from "./state.js";

// ═══════════════════════════════════════════════════════════════
// Folder Structure Restore (shared with sharing)
// ═══════════════════════════════════════════════════════════════

/**
 * Restore folder structure in a local drive from a folder/doc mapping.
 * Sorts folders topologically (parents first), then moves docs into folders.
 * Used by both hydration and import.
 */
export async function restoreFolderStructure(
  reactorClient: ReactorClient,
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

// hydrateFromSwarm + downloadOperations removed — SwarmChannel inbox handles recovery.
// The functions were 450+ lines using old-pipeline state (syncPaused, syncedRevisions, etc.)
// Recovery now works via: SyncManager → SwarmChannel.pollInbox() → reactor.load()
