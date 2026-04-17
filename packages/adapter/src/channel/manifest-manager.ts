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

/**
 * In-memory cache of the last-written user manifest per owner. Swarm feeds
 * are eventually consistent — a feed read immediately after a feed write can
 * still return the pre-write payload. Without this cache, serialized
 * read-modify-writes would all read the same stale manifest and undo each
 * other's changes (confirmed in live logs where two deleted drives both
 * kept re-logging `remaining drives: 1`).
 *
 * The mutex guarantees these entries are only updated by the single call
 * that's currently in the critical section.
 */
const userManifestCache = new Map<string, SwarmUserManifest>();

/**
 * Read the user manifest, preferring our in-process cache from the last
 * successful write. Falls back to Swarm when no cache entry exists.
 */
export async function readUserManifestCached(
  client: SwarmClient,
  ownerAddress: string,
): Promise<SwarmUserManifest | null> {
  const key = ownerAddress.toLowerCase();
  const cached = userManifestCache.get(key);
  if (cached) return cached;
  const remote = await client.readUserManifest(ownerAddress);
  if (remote) userManifestCache.set(key, remote);
  return remote;
}

/**
 * Persist the user manifest to Swarm AND update our in-process cache so
 * the next queued call reads the fresh value instead of Swarm's stale one.
 * Also syncs the UI cache at window.ph.swarm.userManifest so the Settings
 * panel (which reads that cache directly) reflects adds/removes immediately.
 */
async function writeUserManifestAndCache(
  client: SwarmClient,
  ownerAddress: string,
  manifest: SwarmUserManifest,
): Promise<void> {
  await client.updateUserManifest(ownerAddress, manifest);
  userManifestCache.set(ownerAddress.toLowerCase(), manifest);
  // Sync the Settings UI cache. Hydration populates this once on startup
  // but never prunes it — without this sync, Settings → Swarm Storage
  // keeps showing drives we just removed.
  try {
    const ph = (globalThis as any).window?.ph;
    if (ph?.swarm) {
      ph.swarm.userManifest = {
        ...manifest,
        // Preserve any UI-only fields that hydration tacked on
        driveManifests: ph.swarm.userManifest?.driveManifests,
      };
    }
  } catch { /* best effort — not running in a browser */ }
}

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
    let manifest = await readUserManifestCached(client, ownerAddress);
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

    await writeUserManifestAndCache(client, ownerAddress, manifest);
    console.log(`[ManifestManager] User manifest updated: drive "${driveName}" (${driveId.slice(0, 8)}), total drives: ${Object.keys(manifest.drives).length}`);
  });
}

/**
 * Remove a drive entry from the user manifest.
 *
 * Called when the user deletes a drive in Connect — without this the
 * deleted drive keeps appearing in Settings → Swarm (and gets replayed
 * during recovery as a CREATE → DELETE sequence that leaves nothing
 * visible).
 *
 * Serialized through the same per-owner mutex as add/update so a concurrent
 * drive-push-then-delete can't race on the manifest.
 */
export async function removeDriveFromUserManifest(
  client: SwarmClient,
  ownerAddress: string,
  driveId: string,
): Promise<void> {
  return enqueueUserManifestWrite(ownerAddress, async () => {
    const manifest = await readUserManifestCached(client, ownerAddress);
    if (!manifest) return;

    const hadDrive = driveId in (manifest.drives ?? {});
    const hadDoc = driveId in (manifest.documents ?? {});
    if (!hadDrive && !hadDoc) return;

    if (manifest.drives) delete manifest.drives[driveId];
    if (manifest.documents) delete manifest.documents[driveId];
    manifest.updatedAt = new Date().toISOString();

    await writeUserManifestAndCache(client, ownerAddress, manifest);
    console.log(
      `[ManifestManager] User manifest: drive "${driveId.slice(0, 8)}" removed, remaining drives: ${Object.keys(manifest.drives ?? {}).length}`,
    );
  });
}

/**
 * Overwrite a drive manifest feed with an empty payload so recovery on
 * another browser doesn't discover documents for an already-deleted drive.
 *
 * Feed writes are append-only under the hood, so we can't truly "delete"
 * the feed — but an empty manifest makes the drive manifest discovery
 * code treat it as having no documents.
 */
export async function clearDriveManifest(
  client: SwarmClient,
  driveId: string,
): Promise<void> {
  try {
    await client.updateDriveManifest(driveId, {
      driveId,
      name: "",
      documents: {},
      updatedAt: new Date().toISOString(),
    });
    console.log(`[ManifestManager] Drive manifest cleared: ${driveId.slice(0, 8)}`);
  } catch (err) {
    console.warn(
      `[ManifestManager] Failed to clear drive manifest ${driveId.slice(0, 8)}:`,
      err instanceof Error ? err.message : err,
    );
  }
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
    let manifest = await readUserManifestCached(client, ownerAddress);
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

    await writeUserManifestAndCache(client, ownerAddress, manifest);
    console.log(
      `[ManifestManager] Chat peer added: ${normalizedPeer.slice(0, 10)}, total peers: ${manifest.chatPeers.length}`,
    );
  });
}

/**
 * Remove all chat peers from the user manifest. Used by the "Clear
 * chats" action to wipe recovery hints from Swarm so a fresh browser
 * starts with zero conversations. Does not touch drives, documents,
 * stamps, or the chat history feeds themselves (feeds are append-only
 * on Swarm; we simply stop advertising that they exist).
 */
export async function clearChatPeersInUserManifest(
  client: SwarmClient,
  ownerAddress: string,
): Promise<void> {
  return enqueueUserManifestWrite(ownerAddress, async () => {
    const manifest = await readUserManifestCached(client, ownerAddress);
    if (!manifest || !manifest.chatPeers || manifest.chatPeers.length === 0) {
      return;
    }
    const removed = manifest.chatPeers.length;
    manifest.chatPeers = [];
    manifest.updatedAt = new Date().toISOString();
    await writeUserManifestAndCache(client, ownerAddress, manifest);
    console.log(`[ManifestManager] Cleared ${removed} chat peer(s) from user manifest`);
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
 *
 * Caller supplies the drive-listing and drive-read functions so the
 * adapter can stay decoupled from `@powerhousedao/reactor-browser`'s
 * module-level API (`getDrives(client)` vs a client method).
 */
export async function reconcileUserManifestFromReactor(
  client: SwarmClient,
  ownerAddress: string,
  listDrives: () => Promise<unknown[]>,
  getDriveDoc: (driveId: string) => Promise<unknown>,
): Promise<{ reconciled: number; total: number }> {
  let total = 0;
  let reconciled = 0;
  try {
    const drives = await listDrives();
    total = drives?.length ?? 0;
    for (const d of drives ?? []) {
      const driveId: string | undefined =
        (d as any)?.header?.id ?? (d as any)?.id ?? (typeof d === "string" ? d : undefined);
      if (!driveId) continue;
      try {
        const driveDoc = (await getDriveDoc(driveId)) as any;
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
