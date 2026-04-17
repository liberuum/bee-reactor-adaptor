/**
 * Document sharing and public profile management.
 *
 * - Publish a public profile (Bee node public key) for discoverability
 * - Share documents with other users (encrypted drive bundles)
 * - Import documents shared by others
 */
import type { SwarmClient } from "../swarm-client.js";
export declare function publishPublicProfile(client: SwarmClient, ethAddress: string, swarmPublicKey?: string): Promise<void>;
/**
 * The shape written into the ACT-protected /bzz chunk for BOTH the
 * settings-share flow and the chat-share flow. Keeping one shape means
 * `applyDocumentBundle` imports either bundle identically, so the
 * recipient always gets: correct doc names, full op history, folder
 * structure, and the publisher's preferred editor.
 */
export interface DocumentShareBundle {
    documents: Array<{
        documentId: string;
        documentType: string;
        name: string;
        operations: unknown[];
    }>;
    folders?: Record<string, {
        name: string;
        parentFolder?: string;
    }>;
    docFolders?: Record<string, string>;
    preferredEditor?: string;
}
export interface BuiltDriveShareBundle {
    bundle: DocumentShareBundle;
    driveName: string;
    /** Per-doc metadata for the share manifest / chat attachment layer. */
    docs: Array<{
        documentId: string;
        documentType: string;
        name: string;
        operationCount: number;
    }>;
}
/**
 * Collect ops + metadata for a set of docs within a single drive and
 * package them into the canonical share bundle shape. Used by both
 * `shareDocumentsWithUser` (settings → share manifest) and
 * `shareDocumentInChat` (chat → attachment). Returns null when none of
 * the requested docs have any ops to share.
 *
 * Doc name resolution prefers `window.ph.swarm.userManifest.documents`
 * and falls back to the on-chain docId — matching the settings flow so
 * the chat recipient sees "my new doc" instead of a UUID.
 */
export declare function buildDriveShareBundle(client: SwarmClient, driveId: string, docIds: string[]): Promise<BuiltDriveShareBundle | null>;
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