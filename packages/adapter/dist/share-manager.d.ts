/**
 * Document sharing and public profile management for Swarm.
 *
 * Uses Swarm's native ACT (Access Control Trie) for cross-user sharing.
 * ACT provides ECDH-based encryption — the Bee node handles encrypt/decrypt
 * transparently using publisher_privkey × grantee_pubkey.
 *
 * Public profiles and share manifests are intentionally unencrypted (discovery).
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
     * Upload data for sharing — protected by Swarm ACT.
     *
     * The Bee node encrypts the data using its own private key as publisher.
     * The recipient's Bee node public key is added as a grantee, allowing
     * their Bee node to decrypt via ECDH.
     *
     * @param data - Plaintext data to share
     * @param recipientBeeNodePubKey - Recipient's Bee node public key (compressed hex from their profile)
     * @returns ACT metadata needed by recipient to download
     */
    uploadSharedData(data: string | Uint8Array, recipientBeeNodePubKey: string): Promise<{
        reference: string;
        actHistoryAddress: string;
        actGranteeRef: string;
    }>;
    /**
     * Download ACT-protected shared data.
     *
     * The Bee node decrypts transparently using ECDH (our privkey × publisher's pubkey).
     *
     * @param reference - Swarm reference from the share manifest
     * @param publisherBeeNodePubKey - Publisher's Bee node public key (from share manifest)
     * @param actHistoryAddress - ACT history address (from share manifest)
     * @returns Decrypted data
     */
    downloadSharedData(reference: string, publisherBeeNodePubKey: string, actHistoryAddress: string): Promise<Uint8Array>;
    /**
     * Download data encrypted with the legacy deriveShareKey method.
     * Used only for importing v1 share manifests during migration.
     * @deprecated Will be removed after migration window.
     */
    legacyDownloadSharedData(reference: string, senderAddress: string, recipientAddress: string): Promise<Uint8Array>;
    /**
     * Write a share manifest to the share feed between sender and recipient.
     */
    writeShareManifest(senderAddress: string, recipientAddress: string, manifest: ShareManifest): Promise<void>;
    /**
     * Read the share manifest from another user.
     */
    readShareManifest(senderAddress: string, recipientAddress: string): Promise<ShareManifest | null>;
    /**
     * Grant additional users access to previously shared data.
     */
    grantAccess(actGranteeRef: string, actHistoryRef: string, newGranteePubKeys: string[]): Promise<{
        ref: string;
        historyRef: string;
    }>;
    /**
     * Revoke access from users for previously shared data.
     */
    revokeAccess(actGranteeRef: string, actHistoryRef: string, revokePubKeys: string[]): Promise<{
        ref: string;
        historyRef: string;
    }>;
}
//# sourceMappingURL=share-manager.d.ts.map