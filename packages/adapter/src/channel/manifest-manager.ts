/**
 * Manifest Manager for SwarmChannel.
 *
 * Manages the three Swarm manifest layers:
 * 1. User Manifest — top-level index of all drives (discovery for recovery)
 * 2. Drive Manifest — per-drive index of docs + folder structure
 * 3. Document Manifest — per-doc operation batches (handled by SwarmChannel push)
 *
 * The manifests are an index/discovery layer on top of the operation feeds.
 * The reactor's SyncManager handles operation sync; this manager handles
 * the Swarm-specific metadata that enables recovery on a new device.
 */
import type { SwarmClient } from "../swarm-client.js";
import type {
  SwarmUserManifest,
  SwarmDriveManifest,
  UserDriveEntry,
  DriveDocumentEntry,
  DriveFolderEntry,
} from "../types.js";

// ═══════════════════════════════════════════════════════════════
// User Manifest
// ═══════════════════════════════════════════════════════════════

/**
 * Per-owner promise chain used to serialize user-manifest read-modify-writes.
 *
 * Without this, two SwarmChannels pushing concurrently (e.g. two drives each
 * finishing their first push around the same time) would both read the same
 * old manifest, each append their own drive, and each write — the second
 * write clobbers the first, silently dropping a drive from the manifest.
 * Recovery in another browser then only sees one drive.
 *
 * This mutex only guards against same-process races. True cross-browser
 * writes to the same owner's feed are still last-writer-wins, but that's a
 * different problem — for a single wallet used in one browser at a time,
 * this fix is sufficient.
 */
const userManifestWriteChains = new Map<string, Promise<unknown>>();

function enqueueUserManifestWrite<T>(
  ownerAddress: string,
  op: () => Promise<T>,
): Promise<T> {
  const key = ownerAddress.toLowerCase();
  const prev = userManifestWriteChains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => { /* swallow prior error to keep chain alive */ }).then(op);
  // Keep the tail reference so subsequent enqueues chain onto this one
  userManifestWriteChains.set(key, next);
  // Clear the entry once this tail settles so the map doesn't grow
  next.finally(() => {
    if (userManifestWriteChains.get(key) === next) {
      userManifestWriteChains.delete(key);
    }
  }).catch(() => { /* unhandled rejections are surfaced by the returned promise */ });
  return next;
}

/**
 * Ensure the user manifest contains a drive entry.
 * Serialized per-owner so concurrent drives can't race on the manifest.
 */
export async function ensureDriveInUserManifest(
  client: SwarmClient,
  ownerAddress: string,
  driveId: string,
  driveName: string,
  preferredEditor?: string,
): Promise<void> {
  return enqueueUserManifestWrite(ownerAddress, async () => {
    // Re-read fresh INSIDE the critical section so that if another queued
    // write landed between when this call was made and when the mutex
    // unlocked, we merge on top of the latest state instead of stale.
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
      // Already up to date — skip write, keep queue moving fast
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
    console.log(`[ManifestManager] User manifest updated: drive "${driveName}" (${driveId.slice(0, 8)}), total drives: ${Object.keys(manifest.drives).length}`);
  });
}

/**
 * Add a chat peer's signer address to the user manifest so the
 * conversation list can be reconstructed after a fresh install.
 *
 * Serialized through the same per-owner mutex as drive updates, so
 * concurrent startSession calls (e.g. two peers pinging us at once)
 * don't clobber each other.
 */
export async function ensureChatPeerInUserManifest(
  client: SwarmClient,
  ownerAddress: string,
  peerAddress: string,
): Promise<void> {
  const normalizedPeer = peerAddress.toLowerCase();
  return enqueueUserManifestWrite(ownerAddress, async () => {
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

    const existing = manifest.chatPeers ?? [];
    // Normalize for dedup, then preserve original order
    const existingNormalized = new Set(existing.map((p) => p.toLowerCase()));
    if (existingNormalized.has(normalizedPeer)) return;

    manifest.chatPeers = [...existing, normalizedPeer];
    manifest.updatedAt = new Date().toISOString();

    await client.updateUserManifest(ownerAddress, manifest);
    console.log(
      `[ManifestManager] Chat peer added: ${normalizedPeer.slice(0, 10)}, total peers: ${manifest.chatPeers.length}`,
    );
  });
}

/**
 * Reconcile the user manifest against the reactor's local drive list.
 *
 * Walks the reactor's drives and calls ensureDriveInUserManifest for each
 * one. Heals user manifests that ended up partial due to prior
 * concurrency bugs (pre-mutex), ensures brand-new drives that never
 * pushed any ops still appear in the manifest for recovery, and is
 * idempotent (the ensure-call short-circuits when an entry is already
 * up to date).
 *
 * Safe to call on every plugin init — reads are cheap, writes only
 * happen when an entry is missing or changed.
 */
export async function reconcileUserManifestFromReactor(
  client: SwarmClient,
  reactorClient: {
    getDrives: () => Promise<unknown[]>;
    get: (id: string) => Promise<unknown>;
  },
  ownerAddress: string,
): Promise<{ reconciled: number; total: number }> {
  let total = 0;
  let reconciled = 0;
  try {
    const drives = await reactorClient.getDrives();
    total = drives?.length ?? 0;
    for (const d of drives ?? []) {
      const driveId: string | undefined = (d as any)?.header?.id ?? (d as any)?.id;
      if (!driveId) continue;
      try {
        const driveDoc = (await reactorClient.get(driveId)) as any;
        const driveName: string = driveDoc?.state?.global?.name ?? driveId;
        const preferredEditor: string | undefined = driveDoc?.header?.meta?.preferredEditor;
        await ensureDriveInUserManifest(client, ownerAddress, driveId, driveName, preferredEditor);
        reconciled++;
      } catch (err) {
        console.warn(
          `[ManifestManager] Could not reconcile drive ${driveId.slice(0, 8)}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[ManifestManager] Could not list local drives for reconcile:`,
      err instanceof Error ? err.message : err,
    );
  }
  if (total > 0) {
    console.log(
      `[ManifestManager] Reconciled ${reconciled}/${total} local drives into user manifest`,
    );
  }
  return { reconciled, total };
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
export async function updateDriveManifest(
  client: SwarmClient,
  driveId: string,
  nodes: Array<{
    id: string;
    kind: string;
    name: string;
    documentType?: string;
    parentFolder?: string | null;
  }>,
  driveName: string,
  preferredEditor?: string,
): Promise<void> {
  // Read existing drive manifest from Swarm and MERGE new entries.
  // Never remove existing entries — the reactor's drive state may not
  // have all ADD_FILE ops processed yet, so a snapshot could be partial.
  // This ensures recovery always discovers all documents.
  let existing: SwarmDriveManifest | null = null;
  try {
    existing = await client.readDriveManifest(driveId);
  } catch { /* no existing manifest */ }

  const documents: Record<string, DriveDocumentEntry> = {
    ...(existing?.documents ?? {}),
  };
  const folders: Record<string, DriveFolderEntry> = {
    ...(existing?.folders ?? {}),
  };

  const now = new Date().toISOString();

  for (const node of nodes) {
    if (node.kind === "folder") {
      folders[node.id] = {
        name: node.name,
        parentFolder: node.parentFolder ?? undefined,
      };
    } else if (node.kind === "file") {
      documents[node.id] = {
        documentType: node.documentType ?? "unknown",
        name: node.name,
        parentFolder: node.parentFolder ?? undefined,
        lastUpdated: now,
      };
    }
  }

  const manifest: SwarmDriveManifest = {
    driveId,
    name: driveName || existing?.name || driveId,
    preferredEditor: preferredEditor ?? existing?.preferredEditor,
    documents,
    folders: Object.keys(folders).length > 0 ? folders : undefined,
    updatedAt: now,
  };

  await client.updateDriveManifest(driveId, manifest);
  console.log(
    `[ManifestManager] Drive manifest updated: "${manifest.name}" (${driveId.slice(0, 8)}) — ${Object.keys(documents).length} docs, ${Object.keys(folders).length} folders`,
  );
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
export function extractDriveInfoFromOps(
  ops: Array<{ operation?: any; context?: any; action?: any }>,
): {
  driveName: string;
  preferredEditor?: string;
  nodes: Array<{ id: string; kind: string; name: string; documentType?: string; parentFolder?: string | null }>;
} {
  let driveName = "";
  let preferredEditor: string | undefined;
  const nodesMap = new Map<string, {
    id: string;
    kind: string;
    name: string;
    documentType?: string;
    parentFolder?: string | null;
  }>();

  for (const op of ops) {
    const action = op.operation?.action ?? op.action;
    if (!action) continue;

    const type = action.type;
    const input = action.input;
    if (!type || !input) continue;

    switch (type) {
      case "SET_DRIVE_NAME":
        if (input.name) driveName = input.name;
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
        if (input.id) nodesMap.delete(input.id);
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
