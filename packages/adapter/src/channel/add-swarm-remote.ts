/**
 * Register Swarm sync remotes for drives.
 *
 * Called after the Swarm plugin is ready (Bee connected, wallet signed).
 * For each drive in the reactor, registers a "swarm" remote so the
 * SyncManager pushes operations to Swarm via SwarmChannel.
 *
 * Safe to call multiple times — skips drives that already have a Swarm remote.
 */
import type { ISyncManager } from "@powerhousedao/reactor";

/**
 * Format: "drive.{branch}.{driveId}" — matches the reactor's internal
 * driveCollectionId() function.
 */
function driveCollectionId(branch: string, driveId: string): string {
  return `drive.${branch}.${driveId}`;
}

/** Swarm remote naming convention: "swarm:{driveId}" */
function swarmRemoteName(driveId: string): string {
  return `swarm:${driveId}`;
}

export interface SwarmRemoteConfig {
  beeUrl: string;
  batchId: string;
  ownerAddress: string;
  feedTopicPrefix?: string;
  pollIntervalMs?: number;
}

/**
 * Register a Swarm sync remote for a single drive.
 *
 * @returns true if registered, false if already exists
 */
export async function addSwarmRemoteForDrive(
  syncManager: ISyncManager,
  driveId: string,
  config: SwarmRemoteConfig,
): Promise<boolean> {
  const remoteName = swarmRemoteName(driveId);

  // Check if already registered
  try {
    syncManager.getByName(remoteName);
    // Already exists — skip
    return false;
  } catch {
    // Not found — proceed to register
  }

  const collectionId = driveCollectionId("main", driveId);

  await syncManager.add(
    remoteName,
    collectionId,
    {
      type: "swarm",
      parameters: {
        beeUrl: config.beeUrl,
        batchId: config.batchId,
        ownerAddress: config.ownerAddress,
        feedTopicPrefix: config.feedTopicPrefix ?? "ph:v2",
        pollIntervalMs: config.pollIntervalMs ?? 5000,
      },
    },
    {
      documentId: [],
      scope: [],
      branch: "main",
    },
  );

  console.log(`[SwarmChannel] Registered Swarm remote for drive ${driveId.slice(0, 8)} (${remoteName})`);
  return true;
}

/**
 * Register Swarm sync remotes for ALL drives in the reactor.
 *
 * Reads drives from the reactor client, then calls addSwarmRemoteForDrive
 * for each one. Skips drives that already have a Swarm remote.
 *
 * @returns Number of new remotes registered
 */
export async function addSwarmRemotesForAllDrives(
  syncManager: ISyncManager,
  reactorClient: { getDrives(): Promise<Array<{ id: string } | string>> },
  config: SwarmRemoteConfig,
): Promise<number> {
  let registered = 0;

  try {
    const drives = await reactorClient.getDrives();
    for (const drive of drives ?? []) {
      const driveId = typeof drive === "string" ? drive : drive?.id ?? drive;
      if (!driveId) continue;

      try {
        const added = await addSwarmRemoteForDrive(syncManager, driveId, config);
        if (added) registered++;
      } catch (err) {
        console.warn(
          `[SwarmChannel] Failed to register remote for drive ${driveId.slice(0, 8)}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    console.warn(
      "[SwarmChannel] Failed to list drives:",
      err instanceof Error ? err.message : err,
    );
  }

  if (registered > 0) {
    console.log(`[SwarmChannel] Registered ${registered} Swarm remote(s) for drives`);
  }

  return registered;
}
