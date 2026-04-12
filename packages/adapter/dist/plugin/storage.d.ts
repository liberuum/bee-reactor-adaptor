/**
 * Swarm storage utilities.
 *
 * - clearSwarmStorage: wipe all Swarm feeds (Settings UI button)
 * - loadManifestIndex: IndexedDB cache for feed references
 */
import type { SwarmClient } from "../swarm-client.js";
export declare function loadManifestIndex(): Promise<Map<string, string>>;
/**
 * Clear all Swarm storage by writing empty manifests to feeds.
 * Feeds are append-only — we can't delete, but we can overwrite
 * with empty data. The old /bytes data expires when the stamp runs out.
 */
export declare function clearSwarmStorage(swarmClient: SwarmClient, ownerAddress: string): Promise<void>;
//# sourceMappingURL=storage.d.ts.map