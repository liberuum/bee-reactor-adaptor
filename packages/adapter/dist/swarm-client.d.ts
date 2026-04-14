import { Bee, Topic } from "@ethersphere/bee-js";
import type { SwarmDocumentManifest, SwarmDriveManifest, SwarmUserManifest, SwarmPublicProfile, ShareManifest, StampStatus } from "./types.js";
import { StampManager } from "./stamp-manager.js";
import { ShareManager } from "./share-manager.js";
/**
 * Thin wrapper around the Bee SDK providing the specific operations
 * needed by the reactor storage adapter.
 *
 * Supports two modes for manifest storage:
 * - **Feed mode** (production): Uses Swarm feeds (SOC) for mutable manifests.
 *   Requires a full Bee node (not dev mode).
 * - **Bytes mode** (dev/testing): Stores manifests as /bytes and maintains
 *   a local in-memory index of document -> reference. Works with `bee dev`.
 *
 * Stamp management is delegated to StampManager.
 * Sharing and profiles are delegated to ShareManager.
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
    /** Feed index from the last readFeedJson call (for debugging/optimization) */
    private lastFeedIndex;
    /** Next feed index from the last readFeedJson call */
    private lastFeedIndexNext;
    /** Stamp management (status, top-up, pricing, presets) */
    readonly stamps: StampManager;
    /** Document sharing and public profiles */
    readonly sharing: ShareManager;
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
        /** Pre-built Bee instance (for testing / dependency injection). If provided, beeUrl and signerPrivateKey are still used for encryption key derivation. */
        bee?: Bee;
    });
    /**
     * Upload data to Swarm /bytes.
     *
     * When encryption is enabled (default), data is encrypted with AES-256-GCM
     * using the wallet-derived key BEFORE upload. The Bee node never sees plaintext.
     */
    uploadData(data: string | Uint8Array, options?: {
        act?: boolean;
        actHistoryAddress?: string;
        skipEncryption?: boolean;
        /** Track upload progress with a tag. Returns tagUid for polling via waitForConfirmation(). */
        tracked?: boolean;
        /** Use deferred upload (store locally first, push to network in background).
         *  Faster upload — returns immediately. Use with tracked:true to get confirmation. */
        deferred?: boolean;
        /** Erasure coding redundancy level (1-4). Higher = more chunk loss protection.
         *  Level 1: ~1%, Level 2: ~5%, Level 3: ~10%, Level 4: ~25% */
        redundancyLevel?: 1 | 2 | 3 | 4;
    }): Promise<{
        reference: string;
        historyAddress?: string;
        tagUid?: number;
    }>;
    /**
     * Download data from Swarm /bytes by reference.
     *
     * Automatically detects and decrypts AES-256-GCM encrypted data (SWE prefix).
     */
    downloadData(reference: string, options?: {
        actPublisher?: string;
        actHistoryAddress?: string;
        actTimestamp?: number;
        skipDecryption?: boolean;
    }): Promise<Uint8Array>;
    /**
     * Upload raw bytes without SwarmClient encryption (for ShareManager).
     * The caller handles its own encryption with the shared key.
     */
    uploadRawData(data: Uint8Array): Promise<{
        reference: string;
    }>;
    /**
     * Download raw bytes without SwarmClient decryption (for ShareManager).
     * The caller handles its own decryption with the shared key.
     */
    downloadRawData(reference: string): Promise<Uint8Array>;
    grantAccess(granteeRef: string, historyRef: string, publicKeys: string[]): Promise<{
        ref: string;
        historyRef: string;
    }>;
    revokeAccess(granteeRef: string, historyRef: string, publicKeys: string[]): Promise<{
        ref: string;
        historyRef: string;
    }>;
    createGrantees(publicKeys: string[]): Promise<{
        ref: string;
        historyRef: string;
    }>;
    getGrantees(granteeRef: string): Promise<string[]>;
    readManifest(documentId: string): Promise<SwarmDocumentManifest | null>;
    updateManifest(documentId: string, manifest: SwarmDocumentManifest): Promise<void>;
    /**
     * Compact a document's manifest by merging many small operation batches
     * into fewer large ones. Keeps recovery fast (fewer downloads).
     */
    compactManifest(documentId: string, maxBatches?: number): Promise<boolean>;
    readUserManifest(address: string): Promise<SwarmUserManifest | null>;
    updateUserManifest(address: string, manifest: SwarmUserManifest, options?: {
        tracked?: boolean;
    }): Promise<{
        tagUid?: number;
    }>;
    readDriveManifest(driveId: string): Promise<SwarmDriveManifest | null>;
    updateDriveManifest(driveId: string, manifest: SwarmDriveManifest): Promise<void>;
    getOwnerAddress(): string;
    getBeeNodePublicKey(): Promise<string>;
    getNodeWallet(): Promise<{
        address: string;
        xBZZ: string;
        xDAI: string;
    }>;
    isHealthy(): Promise<boolean>;
    /**
     * Get the current status of an upload tag.
     * Returns chunk-level progress: split, seen, stored, sent, synced.
     */
    getTagStatus(tagUid: number): Promise<{
        uid: number;
        split: number;
        seen: number;
        stored: number;
        sent: number;
        synced: number;
        done: boolean;
    }>;
    /**
     * Wait for an upload to be fully confirmed by the network.
     *
     * Polls the tag until `synced >= split` (all chunks have valid receipts
     * from the storage neighborhood). This is REAL network confirmation —
     * not just "the Bee node accepted the data."
     *
     * @param tagUid - Tag UID from uploadData({ tracked: true })
     * @param timeoutMs - Max time to wait (default 60s)
     * @param intervalMs - Polling interval (default 2s)
     * @param onProgress - Optional callback for progress updates
     */
    waitForConfirmation(tagUid: number, timeoutMs?: number, intervalMs?: number, onProgress?: (status: {
        synced: number;
        total: number;
        percent: number;
    }) => void): Promise<{
        synced: number;
        total: number;
        durationMs: number;
    }>;
    /**
     * Get detailed node status snapshot.
     * Much richer than isHealthy() — includes mode, peers, sync rate, reachability.
     */
    getNodeStatus(): Promise<{
        overlay: string;
        beeMode: "light" | "full" | "dev" | "ultra-light" | "unknown";
        isReachable: boolean;
        connectedPeers: number;
        neighborhoodSize: number;
        reserveSize: number;
        pullsyncRate: number;
        storageRadius: number;
    }>;
    /**
     * Check if content is still retrievable from the Swarm network.
     * Returns true if the content can be downloaded, false if chunks are missing.
     */
    isContentAvailable(reference: string): Promise<boolean>;
    /**
     * Re-upload content that may no longer be available in the network.
     * Uses the current stamp to re-stamp the chunks.
     */
    reuploadContent(reference: string): Promise<void>;
    detectFeedSupport(): Promise<boolean>;
    getManifestIndex(): Map<string, string>;
    setManifestIndex(index: Map<string, string>): void;
    /** Get feed index metadata from the last readFeedJson call.
     *  Useful for knowing where you are in the feed sequence. */
    getLastFeedIndex(): {
        feedIndex: unknown;
        feedIndexNext: unknown;
    };
    getStampStatus(): Promise<StampStatus>;
    topUpStamp(amount: bigint | string): Promise<void>;
    expandStamp(newDepth: number): Promise<void>;
    getStoragePrice(): Promise<{
        pricePerBlock: number;
        blockTime: number;
    }>;
    getBzzUsdPrice(): Promise<number | null>;
    estimateStampCost(depth: number, days: number): Promise<{
        xBZZ: string;
        usd: string | null;
        amountPlur: string;
    }>;
    getStampOptions(): Promise<{
        currentDepth: number;
        currentTtlSeconds: number;
        pricePerBlock: number;
        blockTime: number;
        sizeOptions: Array<{
            depth: number;
            label: string;
            effectiveBytes: number;
        }>;
        durationOptions: Array<{
            days: number;
            label: string;
            amount: string;
        }>;
    }>;
    getBucketUtilization(): Promise<{
        depth: number;
        bucketDepth: number;
        bucketUpperBound: number;
        buckets: Array<{
            index: number;
            collisions: number;
        }>;
        hotBuckets: Array<{
            index: number;
            collisions: number;
            percentFull: number;
        }>;
    }>;
    createStamp(amount: string, depth: number, options?: {
        immutable?: boolean;
    }): Promise<string>;
    publishPublicProfile(addr: string, profile: SwarmPublicProfile): Promise<void>;
    readPublicProfile(addr: string): Promise<SwarmPublicProfile | null>;
    uploadSharedData(data: string | Uint8Array, sender: string, recipient: string): Promise<{
        reference: string;
    }>;
    downloadSharedData(ref: string, sender: string, recipient: string): Promise<Uint8Array<ArrayBufferLike>>;
    writeShareManifest(sender: string, recipient: string, manifest: ShareManifest): Promise<void>;
    readShareManifest(sender: string, recipient: string): Promise<ShareManifest | null>;
    /** @deprecated Use getNodeWallet() instead */
    getNodeWalletAddress(): Promise<string>;
    /** @deprecated Use getNodeWallet() instead */
    getNodeBalances(): Promise<{
        xBZZ: string;
        xDAI: string;
    }>;
    documentTopic(documentId: string): Topic;
    userTopic(address: string): Topic;
    profileTopic(address: string): Topic;
    shareTopic(fromAddress: string, toAddress: string): Topic;
    driveTopic(driveId: string): Topic;
    /**
     * Read JSON from a feed. The feed stores a 64-char hex reference
     * pointing to (optionally encrypted) JSON on /bytes.
     */
    /**
     * Read JSON from a feed using the native reference format.
     * Uses downloadReference (binary 32-byte ref) for efficiency.
     *
     * Also captures feed index metadata (feedIndex, feedIndexNext) which
     * can be used for pre-calculating the next write index.
     */
    readFeedJson<T>(topic: Topic, ownerAddress: string, options?: {
        skipDecryption?: boolean;
    }): Promise<T | null>;
    /**
     * Write a /bytes reference to a feed using the native reference format.
     * Uses uploadReference (32-byte binary) — 69% smaller SOC than the legacy
     * uploadPayload approach (64-byte hex text).
     * Serializes writes per topic to prevent SOC conflicts.
     */
    writeFeedPayload(topic: Topic, payload: string): Promise<void>;
    private readManifestFromFeed;
    private updateManifestViaFeed;
    private readManifestFromBytes;
    private updateManifestViaBytes;
}
//# sourceMappingURL=swarm-client.d.ts.map