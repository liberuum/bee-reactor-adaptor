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
/**
 * Ensure the user manifest contains a drive entry.
 * Serialized per-owner so concurrent drives can't race on the manifest.
 */
export declare function ensureDriveInUserManifest(client: SwarmClient, ownerAddress: string, driveId: string, driveName: string, preferredEditor?: string): Promise<void>;
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
export declare function removeDriveFromUserManifest(client: SwarmClient, ownerAddress: string, driveId: string): Promise<void>;
/**
 * Overwrite a drive manifest feed with an empty payload so recovery on
 * another browser doesn't discover documents for an already-deleted drive.
 *
 * Feed writes are append-only under the hood, so we can't truly "delete"
 * the feed — but an empty manifest makes the drive manifest discovery
 * code treat it as having no documents.
 */
export declare function clearDriveManifest(client: SwarmClient, driveId: string): Promise<void>;
/**
 * Add a chat peer's signer address to the user manifest so the
 * conversation list can be reconstructed after a fresh install.
 *
 * Serialized through the same per-owner mutex as drive updates, so
 * concurrent startSession calls (e.g. two peers pinging us at once)
 * don't clobber each other.
 */
export declare function ensureChatPeerInUserManifest(client: SwarmClient, ownerAddress: string, peerAddress: string): Promise<void>;
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
export declare function reconcileUserManifestFromReactor(client: SwarmClient, ownerAddress: string, listDrives: () => Promise<unknown[]>, getDriveDoc: (driveId: string) => Promise<unknown>): Promise<{
    reconciled: number;
    total: number;
}>;
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
export declare function updateDriveManifest(client: SwarmClient, driveId: string, nodes: Array<{
    id: string;
    kind: string;
    name: string;
    documentType?: string;
    parentFolder?: string | null;
}>, driveName: string, preferredEditor?: string): Promise<void>;
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
export declare function extractDriveInfoFromOps(ops: Array<{
    operation?: any;
    context?: any;
    action?: any;
}>): {
    driveName: string;
    preferredEditor?: string;
    nodes: Array<{
        id: string;
        kind: string;
        name: string;
        documentType?: string;
        parentFolder?: string | null;
    }>;
};
//# sourceMappingURL=manifest-manager.d.ts.map