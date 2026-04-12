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
export declare function importFromUser(client: SwarmClient, senderSignerAddress: string): Promise<{
    success: boolean;
    imported: string[];
    error?: string;
}>;
//# sourceMappingURL=sharing.d.ts.map