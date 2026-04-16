/**
 * Document sharing and public profile management.
 *
 * - Publish a public profile (Bee node public key) for discoverability
 * - Share documents with other users (encrypted drive bundles)
 * - Import documents shared by others
 */
import type { SwarmClient } from "../swarm-client.js";
export declare function publishPublicProfile(client: SwarmClient, ethAddress: string, swarmPublicKey?: string): Promise<void>;
export declare function shareDocumentsWithUser(client: SwarmClient, docIds: string[], recipientSignerAddress: string): Promise<{
    success: boolean;
    shared: number;
    error?: string;
}>;
/**
 * Apply a share bundle (already downloaded & decrypted) as a new local
 * drive. The bundle format is identical for share-manifest imports and
 * chat attachment imports, so both flows call this helper.
 *
 * @param bundleData - Raw bundle bytes (JSON, optionally gzipped by ACT)
 * @param opts.cacheKey - sessionStorage key so repeated imports of the
 *                       same share reuse the already-created drive
 * @param opts.displayName - Name shown to the user in the drive list
 */
export declare function applyDocumentBundle(bundleData: Uint8Array, opts: {
    cacheKey: string;
    displayName: string;
}): Promise<{
    success: boolean;
    driveId?: string;
    imported: string[];
    error?: string;
}>;
export declare function importFromUser(client: SwarmClient, senderSignerAddress: string): Promise<{
    success: boolean;
    imported: string[];
    error?: string;
}>;
//# sourceMappingURL=sharing.d.ts.map