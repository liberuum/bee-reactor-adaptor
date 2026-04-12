import { state } from "./state.js";
// ═══════════════════════════════════════════════════════════════
// Folder Structure Restore (shared with sharing)
// ═══════════════════════════════════════════════════════════════
/**
 * Restore folder structure in a local drive from a folder/doc mapping.
 * Sorts folders topologically (parents first), then moves docs into folders.
 * Used by both hydration and import.
 */
export async function restoreFolderStructure(reactorClient, driveId, folders, docMoves) {
    if (Object.keys(folders).length === 0 && docMoves.length === 0)
        return;
    const actions = [];
    // Sort folders topologically — parents before children.
    // Uses a "visiting" set to detect cycles (corrupted/malicious folder data).
    const sorted = [];
    const added = new Set();
    const visiting = new Set();
    function addFolder(id, folder) {
        if (added.has(id))
            return;
        if (visiting.has(id))
            return; // Cycle detected — break the loop
        visiting.add(id);
        if (folder.parentFolder && folders[folder.parentFolder] && !added.has(folder.parentFolder)) {
            addFolder(folder.parentFolder, folders[folder.parentFolder]);
        }
        sorted.push([id, folder]);
        added.add(id);
        visiting.delete(id);
    }
    for (const [id, folder] of Object.entries(folders))
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
    for (const { docId, targetFolder } of docMoves) {
        actions.push({
            id: crypto.randomUUID(),
            timestampUtcMs: new Date().toISOString(),
            type: "MOVE_NODE",
            input: { srcFolder: docId, targetParentFolder: targetFolder },
            scope: "global",
        });
    }
    if (actions.length === 0)
        return;
    console.log(`[SwarmPlugin] Restoring ${actions.length} folder/move actions for drive ${driveId.slice(0, 8)}`);
    // Execute one at a time — reactor needs state to settle between each
    for (const action of actions) {
        try {
            await reactorClient.execute(driveId, "main", [action]);
            await new Promise((r) => setTimeout(r, 200));
        }
        catch (err) {
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
export async function populateUiCacheFromDrives(userManifest) {
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
        documents[driveId] = {
            documentType: "powerhouse/document-drive",
            name: driveEntry.name || driveId,
            driveId: "",
            lastUpdated: driveEntry.lastUpdated || new Date().toISOString(),
        };
        try {
            const dm = await swarmClient.readDriveManifest(driveId);
            if (dm) {
                // Cache for Settings UI tree view
                state.driveManifestCache.set(driveId, dm);
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
    // Populate docToDrive and driveNames from the drive manifests
    for (const [docId, entry] of Object.entries(documents)) {
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
    }
    else {
        ph.swarm.userManifest.documents = { ...ph.swarm.userManifest.documents, ...documents };
    }
    // Store drive manifest folder info for the Settings UI tree
    if (!ph.swarm.userManifest.driveManifests)
        ph.swarm.userManifest.driveManifests = {};
    for (const [driveId] of Object.entries(drives)) {
        const cached = state.driveManifestCache.get(driveId);
        if (cached?.folders) {
            ph.swarm.userManifest.driveManifests[driveId] = { folders: cached.folders };
        }
    }
}
//# sourceMappingURL=hydration.js.map