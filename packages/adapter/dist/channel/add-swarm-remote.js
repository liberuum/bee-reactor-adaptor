/**
 * Format: "drive.{branch}.{driveId}" — matches the reactor's internal
 * driveCollectionId() function.
 */
function driveCollectionId(branch, driveId) {
    return `drive.${branch}.${driveId}`;
}
/** Swarm remote naming convention: "swarm:{driveId}" */
function swarmRemoteName(driveId) {
    return `swarm:${driveId}`;
}
/**
 * Register a Swarm sync remote for a single drive.
 *
 * @returns true if registered, false if already exists
 */
export async function addSwarmRemoteForDrive(syncManager, driveId, config) {
    const remoteName = swarmRemoteName(driveId);
    // Check if already registered
    try {
        syncManager.getByName(remoteName);
        // Already exists — skip
        return false;
    }
    catch {
        // Not found — proceed to register
    }
    const collectionId = driveCollectionId("main", driveId);
    await syncManager.add(remoteName, collectionId, {
        type: "swarm",
        parameters: {
            beeUrl: config.beeUrl,
            batchId: config.batchId,
            ownerAddress: config.ownerAddress,
            feedTopicPrefix: config.feedTopicPrefix ?? "ph:v2",
            pollIntervalMs: config.pollIntervalMs ?? 5000,
        },
    }, {
        documentId: [],
        scope: [],
        branch: "main",
    });
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
export async function addSwarmRemotesForAllDrives(syncManager, reactorClient, config) {
    let registered = 0;
    try {
        const drives = await reactorClient.getDrives();
        for (const drive of drives ?? []) {
            const driveId = typeof drive === "string" ? drive : drive?.id ?? drive;
            if (!driveId)
                continue;
            try {
                const added = await addSwarmRemoteForDrive(syncManager, driveId, config);
                if (added)
                    registered++;
            }
            catch (err) {
                console.warn(`[SwarmChannel] Failed to register remote for drive ${driveId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
            }
        }
    }
    catch (err) {
        console.warn("[SwarmChannel] Failed to list drives:", err instanceof Error ? err.message : err);
    }
    if (registered > 0) {
        console.log(`[SwarmChannel] Registered ${registered} Swarm remote(s) for drives`);
    }
    return registered;
}
//# sourceMappingURL=add-swarm-remote.js.map