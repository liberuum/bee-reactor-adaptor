/**
 * Document sharing and public profile management for Swarm.
 *
 * Handles cross-user encrypted sharing (SHA-256 derived shared keys),
 * share manifests, and public profile publishing/discovery.
 *
 * Extracted from SwarmClient to keep it focused on core data operations.
 */
import type { SwarmClient } from "./swarm-client.js";
import type { SwarmPublicProfile, ShareManifest } from "./types.js";
export declare class ShareManager {
    private readonly client;
    constructor(client: SwarmClient);
    /**
     * Publish the user's public profile to an UNENCRYPTED feed.
     */
    publishPublicProfile(signerAddress: string, profile: SwarmPublicProfile): Promise<void>;
    /**
     * Read a user's public profile by their Swarm signer address.
     * Returns null if the user hasn't published a profile yet.
     */
    readPublicProfile(signerAddress: string): Promise<SwarmPublicProfile | null>;
    /**
     * Upload data for sharing — encrypted with a key derived from both parties' addresses.
     * Both sender and recipient can derive the same key: SHA-256(sender:recipient).
     */
    uploadSharedData(data: string | Uint8Array, senderAddress: string, recipientAddress: string): Promise<{
        reference: string;
    }>;
    /**
     * Download shared data and decrypt with the shared key.
     */
    downloadSharedData(reference: string, senderAddress: string, recipientAddress: string): Promise<Uint8Array>;
    /**
     * Write a share manifest to the share feed between sender and recipient.
     */
    writeShareManifest(senderAddress: string, recipientAddress: string, manifest: ShareManifest): Promise<void>;
    /**
     * Read the share manifest from another user.
     */
    readShareManifest(senderAddress: string, recipientAddress: string): Promise<ShareManifest | null>;
}
/**
 * Derive a 32-byte hex key for share encryption from both parties' addresses.
 * SHA-256(sender_normalized + ":" + recipient_normalized) → 64-char hex string.
 * Both sender and recipient can independently derive the same key.
 */
export declare function deriveShareKey(senderAddress: string, recipientAddress: string): Promise<string>;
//# sourceMappingURL=share-manager.d.ts.map