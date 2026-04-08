import { Topic } from "@ethersphere/bee-js";
import type { SwarmDocumentManifest, SwarmUserManifest, SwarmPublicProfile, ShareManifest, StampStatus } from "./types.js";
/**
 * Thin wrapper around the Bee SDK providing the specific operations
 * needed by the reactor storage adapter.
 *
 * Supports two modes for manifest storage:
 * - **Feed mode** (production): Uses Swarm feeds (SOC) for mutable manifests.
 *   Requires a full Bee node (not dev mode).
 * - **Bytes mode** (dev/testing): Stores manifests as /bytes and maintains
 *   a local in-memory index of document -> reference. Works with `bee dev`.
 */
export declare class SwarmClient {
    private readonly bee;
    private readonly batchId;
    private readonly useFeedMode;
    private readonly feedTopicPrefix;
    /** The wallet-derived key used for app-layer AES-256-GCM encryption */
    private readonly encryptionKey;
    /** Whether to encrypt data before upload. Default: true */
    private readonly useEncryption;
    /**
     * In-memory index: documentId -> latest manifest reference.
     * Used in bytes mode when feeds are not available.
     */
    private manifestIndex;
    /** Per-topic write lock — serializes feed writes to prevent concurrent index conflicts */
    private feedWriteLocks;
    constructor(config: {
        beeUrl: string;
        batchId: string;
        signerPrivateKey: string;
        /** Use feeds for manifest storage. Set to false for bee dev mode. Default: auto-detect */
        useFeedMode?: boolean;
        /** Feed topic prefix. Change this to migrate to fresh feeds (e.g. after corruption). Default: "ph" */
        feedTopicPrefix?: string;
        /** Enable app-layer AES-256-GCM encryption. Default: true */
        useEncryption?: boolean;
    });
    /**
     * Upload data to Swarm /bytes.
     *
     * When encryption is enabled (default), data is encrypted with AES-256-GCM
     * using the wallet-derived key BEFORE upload. The Bee node never sees plaintext.
     *
     * @param data - Data to upload (will be encrypted if useEncryption is true)
     * @param options - Optional: skip encryption, enable ACT, provide history
     */
    uploadData(data: string | Uint8Array, options?: {
        act?: boolean;
        actHistoryAddress?: string;
        skipEncryption?: boolean;
    }): Promise<{
        reference: string;
        historyAddress?: string;
    }>;
    /**
     * Download data from Swarm /bytes by reference.
     *
     * Automatically detects and decrypts AES-256-GCM encrypted data (SWE prefix).
     * Handles mixed encrypted/unencrypted content for backward compatibility.
     *
     * @param reference - Content reference
     * @param options - Optional: ACT parameters, skip decryption
     */
    downloadData(reference: string, options?: {
        actPublisher?: string;
        actHistoryAddress?: string;
        actTimestamp?: number;
        skipDecryption?: boolean;
    }): Promise<Uint8Array>;
    /**
     * Grant access to encrypted content for specific Ethereum public keys.
     */
    grantAccess(granteeRef: string, historyRef: string, publicKeys: string[]): Promise<{
        ref: string;
        historyRef: string;
    }>;
    /**
     * Revoke access to encrypted content from specific Ethereum public keys.
     */
    revokeAccess(granteeRef: string, historyRef: string, publicKeys: string[]): Promise<{
        ref: string;
        historyRef: string;
    }>;
    /**
     * Create a new grantee list for ACT access control.
     */
    createGrantees(publicKeys: string[]): Promise<{
        ref: string;
        historyRef: string;
    }>;
    /**
     * Get the current grantee list (publisher only).
     */
    getGrantees(granteeRef: string): Promise<string[]>;
    /**
     * Read the document manifest.
     * Uses feeds in production, or /bytes + local index in dev mode.
     */
    readManifest(documentId: string): Promise<SwarmDocumentManifest | null>;
    /**
     * Update the document manifest.
     * Uses feeds in production, or /bytes + local index in dev mode.
     */
    updateManifest(documentId: string, manifest: SwarmDocumentManifest): Promise<void>;
    /**
     * Get the Ethereum address derived from the signer private key.
     */
    getOwnerAddress(): string;
    /**
     * Get the Bee node's public key (for ACT sharing — this is what other
     * users need to grant you access to their encrypted content).
     */
    getBeeNodePublicKey(): Promise<string>;
    /**
     * Get the Bee node's Gnosis Chain wallet address and balances.
     * The wallet endpoint returns everything we need for the settings UI.
     */
    getNodeWallet(): Promise<{
        address: string;
        xBZZ: string;
        xDAI: string;
    }>;
    /**
     * @deprecated Use getNodeWallet() instead
     */
    getNodeWalletAddress(): Promise<string>;
    /**
     * @deprecated Use getNodeWallet() instead
     */
    getNodeBalances(): Promise<{
        xBZZ: string;
        xDAI: string;
    }>;
    /**
     * Create a new postage stamp batch. The Bee node's wallet must be funded
     * with xBZZ and xDAI first.
     * @param amount Per-chunk xBZZ allocation (determines duration)
     * @param depth Batch depth (determines capacity, minimum 17)
     */
    createStamp(amount: string, depth: number): Promise<string>;
    /**
     * Check if the Bee node is reachable.
     */
    isHealthy(): Promise<boolean>;
    /**
     * Auto-detect whether feeds are supported by the connected node.
     * Updates the internal mode accordingly.
     */
    detectFeedSupport(): Promise<boolean>;
    /**
     * Get the local manifest index (for bytes mode).
     * Useful for persisting the index across restarts.
     */
    getManifestIndex(): Map<string, string>;
    /**
     * Restore the local manifest index (for bytes mode).
     */
    setManifestIndex(index: Map<string, string>): void;
    /**
     * Read the user manifest from Swarm for a given Ethereum address.
     * Returns null if no manifest exists.
     */
    readUserManifest(address: string): Promise<SwarmUserManifest | null>;
    /**
     * Update the user manifest on Swarm.
     */
    updateUserManifest(address: string, manifest: SwarmUserManifest): Promise<void>;
    /**
     * Get the current status of the postage stamp.
     */
    getStampStatus(): Promise<StampStatus>;
    /**
     * Top up the postage stamp to extend its TTL.
     */
    topUpStamp(additionalAmount: bigint | string): Promise<void>;
    /**
     * Dilute the stamp to increase capacity (trades TTL for space).
     */
    expandStamp(newDepth: number): Promise<void>;
    /**
     * Get current storage price from the Bee node's chain state.
     * Returns pricePerBlock (PLUR per chunk per block) and blockTime (seconds).
     */
    getStoragePrice(): Promise<{
        pricePerBlock: number;
        blockTime: number;
    }>;
    /**
     * Get xBZZ/USD market price from CoinGecko.
     * Returns null if the API is unreachable.
     */
    getBzzUsdPrice(): Promise<number | null>;
    /**
     * Estimate cost for a stamp operation.
     *
     * @param depth - Batch depth
     * @param days - Duration in days
     * @returns Cost estimate in xBZZ and USD (if price available)
     */
    estimateStampCost(depth: number, days: number): Promise<{
        xBZZ: string;
        usd: string | null;
        amountPlur: string;
    }>;
    /**
     * Get stamp management options with human-readable presets.
     * Fetches current price and computes costs for common operations.
     */
    getStampOptions(): Promise<{
        currentDepth: number;
        currentTtlSeconds: number;
        pricePerBlock: number;
        blockTime: number;
        /** Predefined storage size options (depth → human size) */
        sizeOptions: Array<{
            depth: number;
            label: string;
            effectiveBytes: number;
        }>;
        /** Predefined duration options with computed PLUR amounts */
        durationOptions: Array<{
            days: number;
            label: string;
            amount: string;
        }>;
    }>;
    /**
     * Publish the user's public profile to an UNENCRYPTED feed.
     * The profile is keyed by the signer address (= feed owner), so
     * anyone who knows the signer address can discover the profile.
     *
     * @param signerAddress - The signer's address (from getOwnerAddress())
     * @param profile - The profile data to publish
     */
    publishPublicProfile(signerAddress: string, profile: SwarmPublicProfile): Promise<void>;
    /**
     * Read a user's public profile by their Swarm signer address.
     * Returns null if the user hasn't published a profile yet.
     *
     * The signer address IS the feed owner, so this works for cross-user reads.
     * Note: this takes a signer address, NOT an ETH wallet address.
     *
     * @param signerAddress - The target user's signer address (NOT their ETH wallet address)
     */
    readPublicProfile(signerAddress: string): Promise<SwarmPublicProfile | null>;
    /**
     * Upload data for sharing — encrypted with a key derived from both parties' addresses.
     * Both sender and recipient can derive the same key: SHA-256(sender:recipient).
     * Third parties can't decrypt without knowing both signer addresses.
     *
     * @param data - The operation data to share
     * @param senderAddress - Sender's signer address
     * @param recipientAddress - Recipient's signer address
     */
    uploadSharedData(data: string | Uint8Array, senderAddress: string, recipientAddress: string): Promise<{
        reference: string;
    }>;
    /**
     * Download shared data and decrypt with the shared key.
     * The key is derived from both parties' addresses: SHA-256(sender:recipient).
     *
     * @param reference - Swarm reference
     * @param senderAddress - Sender's signer address
     * @param recipientAddress - Recipient's signer address (= our address when importing)
     */
    downloadSharedData(reference: string, senderAddress: string, recipientAddress: string): Promise<Uint8Array>;
    /**
     * Write a share manifest to the share feed between sender and recipient.
     */
    writeShareManifest(senderAddress: string, recipientAddress: string, manifest: ShareManifest): Promise<void>;
    /**
     * Read the share manifest from another user.
     * Alice reads: shareTopic(bob, alice) with owner = bob's address.
     *
     * Note: The share manifest is encrypted with the sender's key.
     * The recipient needs their own copy or the manifest should use
     * a shared encryption scheme. For now, we store it unencrypted
     * on the feed (the feed topic is obscure enough).
     */
    readShareManifest(senderAddress: string, recipientAddress: string): Promise<ShareManifest | null>;
    /**
     * Compact a document's manifest by merging many small operation batches
     * into fewer large ones. This keeps recovery fast (fewer downloads).
     *
     * Called periodically or on startup. Old batches remain on Swarm but
     * expire naturally when the stamp runs out.
     *
     * @param documentId - The document to compact
     * @param maxBatches - Don't compact if batch count is at or below this (default: 20)
     * @returns true if compaction was performed, false if not needed
     */
    compactManifest(documentId: string, maxBatches?: number): Promise<boolean>;
    /**
     * Derive a deterministic feed topic for a document.
     */
    documentTopic(documentId: string): Topic;
    /**
     * Derive a deterministic feed topic for a user's manifest.
     */
    userTopic(address: string): Topic;
    /**
     * Derive a deterministic feed topic for a user's public profile.
     */
    profileTopic(address: string): Topic;
    /**
     * Derive a deterministic feed topic for shares between two users.
     */
    shareTopic(fromAddress: string, toAddress: string): Topic;
    /**
     * Read document manifest from feed.
     *
     * Supports two feed formats (auto-detected):
     * - **Reference format** (new): Feed entry is a 64-char hex reference to /bytes
     *   containing the manifest JSON. Only 72 bytes in the SOC (8-byte timestamp + ref).
     * - **Inline format** (legacy): Feed entry IS the manifest JSON directly.
     *
     * New writes always use reference format. Old feeds upgrade transparently on next write.
     */
    private readManifestFromFeed;
    /**
     * Write document manifest to feed using the reference pattern.
     *
     * Instead of writing the full manifest JSON to the feed (which can be large
     * and makes SOC writes slow), we:
     * 1. Upload manifest JSON to /bytes (content-addressed, fast)
     * 2. Write only the 64-char reference to the feed (72-byte SOC)
     *
     * This follows the Swarm "regenerate and publish" pattern (Etherjot pattern):
     * feeds store pointers to immutable data, not the data itself.
     */
    private updateManifestViaFeed;
    /**
     * Write payload to a feed, serialized per topic.
     *
     * Per Swarm docs: each feed index is write-once, and the recommended
     * approach is to let bee-js find the next index automatically via
     * `uploadPayload()` without specifying an index.
     *
     * The write lock ensures only one write per topic at a time,
     * preventing two concurrent writers from getting the same
     * `feedIndexNext` (which would cause a 400 SOC conflict).
     */
    private writeFeedPayload;
    private readManifestFromBytes;
    private updateManifestViaBytes;
}
//# sourceMappingURL=swarm-client.d.ts.map