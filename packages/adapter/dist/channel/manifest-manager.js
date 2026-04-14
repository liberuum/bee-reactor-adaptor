// ═══════════════════════════════════════════════════════════════
// User Manifest
// ═══════════════════════════════════════════════════════════════
/**
 * Ensure the user manifest contains a drive entry.
 * Creates or updates the entry. Debounced writes via the SwarmClient.
 */
export async function ensureDriveInUserManifest(client, ownerAddress, driveId, driveName, preferredEditor) {
    let manifest = await client.readUserManifest(ownerAddress);
    if (!manifest) {
        manifest = {
            address: ownerAddress,
            documents: {},
            drives: {},
            stamps: {},
            updatedAt: new Date().toISOString(),
        };
    }
    const existing = manifest.drives[driveId];
    const now = new Date().toISOString();
    if (existing && existing.name === driveName && existing.preferredEditor === preferredEditor) {
        // Already up to date
        return;
    }
    manifest.drives[driveId] = {
        name: driveName || existing?.name || driveId,
        documentIds: existing?.documentIds ?? [],
        preferredEditor: preferredEditor ?? existing?.preferredEditor,
        lastUpdated: now,
    };
    // Also add the drive as a "document" entry (for Settings UI compatibility)
    manifest.documents[driveId] = {
        documentType: "powerhouse/document-drive",
        name: driveName,
        driveId: "",
        lastUpdated: now,
    };
    manifest.updatedAt = now;
    await client.updateUserManifest(ownerAddress, manifest);
    console.log(`[ManifestManager] User manifest updated: drive "${driveName}" (${driveId.slice(0, 8)})`);
}
// ═══════════════════════════════════════════════════════════════
// Drive Manifest
// ═══════════════════════════════════════════════════════════════
/**
 * Update the drive manifest from the reactor's drive state.
 *
 * Extracts nodes (files + folders) from the drive document and writes
 * them to the drive manifest feed on Swarm.
 *
 * @param nodes - The flat nodes array from drive.state.global.nodes
 * @param driveName - The drive's display name
 * @param preferredEditor - The drive's preferred editor type
 */
export async function updateDriveManifest(client, driveId, nodes, driveName, preferredEditor) {
    // Read existing drive manifest from Swarm and MERGE new entries.
    // Never remove existing entries — the reactor's drive state may not
    // have all ADD_FILE ops processed yet, so a snapshot could be partial.
    // This ensures recovery always discovers all documents.
    let existing = null;
    try {
        existing = await client.readDriveManifest(driveId);
    }
    catch { /* no existing manifest */ }
    const documents = {
        ...(existing?.documents ?? {}),
    };
    const folders = {
        ...(existing?.folders ?? {}),
    };
    const now = new Date().toISOString();
    for (const node of nodes) {
        if (node.kind === "folder") {
            folders[node.id] = {
                name: node.name,
                parentFolder: node.parentFolder ?? undefined,
            };
        }
        else if (node.kind === "file") {
            documents[node.id] = {
                documentType: node.documentType ?? "unknown",
                name: node.name,
                parentFolder: node.parentFolder ?? undefined,
                lastUpdated: now,
            };
        }
    }
    const manifest = {
        driveId,
        name: driveName || existing?.name || driveId,
        preferredEditor: preferredEditor ?? existing?.preferredEditor,
        documents,
        folders: Object.keys(folders).length > 0 ? folders : undefined,
        updatedAt: now,
    };
    await client.updateDriveManifest(driveId, manifest);
    console.log(`[ManifestManager] Drive manifest updated: "${manifest.name}" (${driveId.slice(0, 8)}) — ${Object.keys(documents).length} docs, ${Object.keys(folders).length} folders`);
}
// ═══════════════════════════════════════════════════════════════
// Extract Drive State from Operations
// ═══════════════════════════════════════════════════════════════
/**
 * Extract drive name, preferredEditor, and nodes from drive operations.
 *
 * Drive operations include: SET_DRIVE_NAME, ADD_FILE, ADD_FOLDER,
 * MOVE_NODE, DELETE_NODE, etc. We extract the resulting state by
 * replaying the ops' effects on the drive metadata.
 *
 * For the most accurate state, we read from the reactor client
 * rather than replaying ops. But this function handles the case
 * where we only have operations (e.g., during pull/recovery).
 */
export function extractDriveInfoFromOps(ops) {
    let driveName = "";
    let preferredEditor;
    const nodesMap = new Map();
    for (const op of ops) {
        const action = op.operation?.action ?? op.action;
        if (!action)
            continue;
        const type = action.type;
        const input = action.input;
        if (!type || !input)
            continue;
        switch (type) {
            case "SET_DRIVE_NAME":
                if (input.name)
                    driveName = input.name;
                break;
            case "ADD_FILE":
                nodesMap.set(input.id, {
                    id: input.id,
                    kind: "file",
                    name: input.name ?? input.id,
                    documentType: input.documentType,
                    parentFolder: input.parentFolder ?? null,
                });
                break;
            case "ADD_FOLDER":
                nodesMap.set(input.id, {
                    id: input.id,
                    kind: "folder",
                    name: input.name ?? input.id,
                    parentFolder: input.parentFolder ?? null,
                });
                break;
            case "MOVE_NODE":
                // Move a node to a different parent folder
                if (input.srcFolder) {
                    const node = nodesMap.get(input.srcFolder);
                    if (node) {
                        node.parentFolder = input.targetParentFolder ?? null;
                    }
                }
                break;
            case "DELETE_NODE":
                if (input.id)
                    nodesMap.delete(input.id);
                break;
            case "CREATE_DOCUMENT":
                // Initial drive creation — may contain preferredEditor
                if (input.meta?.preferredEditor) {
                    preferredEditor = input.meta.preferredEditor;
                }
                break;
            case "UPGRADE_DOCUMENT":
                // May contain initial state with drive name
                if (input.initialState?.global?.name) {
                    driveName = input.initialState.global.name;
                }
                break;
        }
    }
    return {
        driveName,
        preferredEditor,
        nodes: Array.from(nodesMap.values()),
    };
}
//# sourceMappingURL=manifest-manager.js.map