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
export declare function addSwarmRemoteForDrive(syncManager: ISyncManager, driveId: string, config: SwarmRemoteConfig): Promise<boolean>;
/**
 * Register Swarm sync remotes for ALL drives in the reactor.
 *
 * Reads drives from the reactor client, then calls addSwarmRemoteForDrive
 * for each one. Skips drives that already have a Swarm remote.
 *
 * @returns Number of new remotes registered
 */
export declare function addSwarmRemotesForAllDrives(syncManager: ISyncManager, reactorClient: {
    getDrives(): Promise<Array<{
        id: string;
    } | string>>;
}, config: SwarmRemoteConfig): Promise<number>;
//# sourceMappingURL=add-swarm-remote.d.ts.map