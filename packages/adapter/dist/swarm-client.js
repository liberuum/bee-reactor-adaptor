import { Bee, Topic } from "@ethersphere/bee-js";
import { encrypt, decrypt, isEncrypted } from "./swarm-crypto.js";
import { StampManager, getBzzUsdPrice } from "./stamp-manager.js";
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
export class SwarmClient {
    bee;
    batchId;
    useFeedMode;
    feedTopicPrefix;
    /** The wallet-derived key used for app-layer AES-256-GCM encryption */
    encryptionKey;
    /** Whether to encrypt data before upload. Default: true */
    useEncryption;
    /**
     * In-memory index: documentId -> latest manifest reference.
     * Used in bytes mode when feeds are not available.
     */
    manifestIndex = new Map();
    /** Per-topic write lock — serializes feed writes to prevent concurrent index conflicts */
    feedWriteLocks = new Map();
    /** Feed index from the last readFeedJson call (for debugging/optimization) */
    lastFeedIndex = undefined;
    /** Next feed index from the last readFeedJson call */
    lastFeedIndexNext = undefined;
    /** Stamp management (status, top-up, pricing, presets) */
    stamps;
    /** Document sharing and public profiles */
    sharing;
    constructor(config) {
        this.bee = config.bee ?? new Bee(config.beeUrl, {
            signer: config.signerPrivateKey,
        });
        this.batchId = config.batchId;
        this.useFeedMode = config.useFeedMode ?? true;
        this.feedTopicPrefix = config.feedTopicPrefix ?? "ph";
        this.encryptionKey = config.signerPrivateKey;
        this.useEncryption = config.useEncryption ?? true;
        this.stamps = new StampManager(this.bee, this.batchId);
        this.sharing = new ShareManager(this);
    }
    // ═══════════════════════════════════════════════════════════════
    // Core Data Operations
    // ═══════════════════════════════════════════════════════════════
    /**
     * Upload data to Swarm /bytes.
     *
     * When encryption is enabled (default), data is encrypted with AES-256-GCM
     * using the wallet-derived key BEFORE upload. The Bee node never sees plaintext.
     */
    async uploadData(data, options) {
        let payload = data;
        if (this.useEncryption && !options?.skipEncryption) {
            payload = await encrypt(data, this.encryptionKey);
        }
        // Create a tag for upload tracking if requested
        let tag;
        if (options?.tracked || options?.deferred) {
            const created = await this.bee.createTag();
            tag = created.uid;
        }
        const result = await this.bee.uploadData(this.batchId, payload, {
            act: options?.act,
            actHistoryAddress: options?.actHistoryAddress,
            redundancyLevel: options?.redundancyLevel,
            tag,
            deferred: options?.deferred,
        });
        const historyRef = result.historyAddress?.value ?? result.historyAddress;
        return {
            reference: result.reference.toHex(),
            historyAddress: historyRef && typeof historyRef === "object" && "toHex" in historyRef
                ? historyRef.toHex()
                : undefined,
            tagUid: tag,
        };
    }
    /**
     * Download data from Swarm /bytes by reference.
     *
     * Automatically detects and decrypts AES-256-GCM encrypted data (SWE prefix).
     */
    async downloadData(reference, options) {
        const raw = await this.bee.downloadData(reference, {
            actPublisher: options?.actPublisher,
            actHistoryAddress: options?.actHistoryAddress,
            actTimestamp: options?.actTimestamp,
        });
        const data = raw.toUint8Array();
        if (!options?.skipDecryption && isEncrypted(data)) {
            return decrypt(data, this.encryptionKey);
        }
        return data;
    }
    /**
     * Upload raw bytes without SwarmClient encryption (for ShareManager).
     * The caller handles its own encryption with the shared key.
     */
    async uploadRawData(data) {
        const result = await this.bee.uploadData(this.batchId, data);
        return { reference: result.reference.toHex() };
    }
    /**
     * Download raw bytes without SwarmClient decryption (for ShareManager).
     * The caller handles its own decryption with the shared key.
     */
    async downloadRawData(reference) {
        const raw = await this.bee.downloadData(reference);
        return raw.toUint8Array();
    }
    // ═══════════════════════════════════════════════════════════════
    // File Upload/Download (via /bzz — required for ACT)
    // ═══════════════════════════════════════════════════════════════
    /**
     * Upload data as a file via /bzz endpoint.
     *
     * Unlike uploadData (/bytes), /bzz supports ACT decryption on download.
     * Use this for any ACT-protected content (sharing, chat history).
     */
    async uploadFile(data, options) {
        let payload = data;
        if (this.useEncryption && !options?.skipEncryption) {
            payload = await encrypt(data, this.encryptionKey);
        }
        const result = await this.bee.uploadFile(this.batchId, payload, "data.bin", {
            act: options?.act,
            actHistoryAddress: options?.actHistoryAddress,
        });
        const historyRef = result.historyAddress?.value ?? result.historyAddress;
        return {
            reference: result.reference.toHex(),
            historyAddress: historyRef && typeof historyRef === "object" && "toHex" in historyRef
                ? historyRef.toHex()
                : typeof historyRef === "string" ? historyRef : undefined,
        };
    }
    /**
     * Download a file via /bzz endpoint.
     *
     * Unlike downloadData (/bytes), /bzz handles ACT manifest resolution
     * and ECDH decryption transparently. Required for cross-node ACT.
     */
    async downloadFile(reference, options) {
        const result = await this.bee.downloadFile(reference, "", {
            actPublisher: options?.actPublisher,
            actHistoryAddress: options?.actHistoryAddress,
            actTimestamp: options?.actTimestamp,
        });
        const data = result.data.toUint8Array();
        if (!options?.skipDecryption && isEncrypted(data)) {
            return decrypt(data, this.encryptionKey);
        }
        return data;
    }
    // ═══════════════════════════════════════════════════════════════
    // ACT Access Control
    // ═══════════════════════════════════════════════════════════════
    async grantAccess(granteeRef, historyRef, publicKeys) {
        const result = await this.bee.patchGrantees(this.batchId, granteeRef, historyRef, { add: publicKeys });
        return { ref: result.ref.toHex(), historyRef: result.historyref.toHex() };
    }
    async revokeAccess(granteeRef, historyRef, publicKeys) {
        const result = await this.bee.patchGrantees(this.batchId, granteeRef, historyRef, { revoke: publicKeys });
        return { ref: result.ref.toHex(), historyRef: result.historyref.toHex() };
    }
    async createGrantees(publicKeys) {
        const result = await this.bee.createGrantees(this.batchId, publicKeys);
        return { ref: result.ref.toHex(), historyRef: result.historyref.toHex() };
    }
    async getGrantees(granteeRef) {
        const result = await this.bee.getGrantees(granteeRef);
        return result.grantees.map((pk) => pk.toCompressedHex());
    }
    // ═══════════════════════════════════════════════════════════════
    // Document Manifest
    // ═══════════════════════════════════════════════════════════════
    async readManifest(documentId) {
        if (this.useFeedMode)
            return this.readManifestFromFeed(documentId);
        return this.readManifestFromBytes(documentId);
    }
    async updateManifest(documentId, manifest) {
        if (this.useFeedMode)
            return this.updateManifestViaFeed(documentId, manifest);
        return this.updateManifestViaBytes(documentId, manifest);
    }
    /**
     * Compact a document's manifest by merging many small operation batches
     * into fewer large ones. Keeps recovery fast (fewer downloads).
     */
    async compactManifest(documentId, maxBatches = 20) {
        const manifest = await this.readManifest(documentId);
        if (!manifest || manifest.operationBatches.length <= maxBatches)
            return false;
        // Group batches by scope:branch to compact each bucket independently
        const buckets = new Map();
        for (const batch of manifest.operationBatches) {
            const key = `${batch.scope}:${batch.branch}`;
            const bucket = buckets.get(key) ?? [];
            bucket.push(batch);
            buckets.set(key, bucket);
        }
        const compactedBatches = [];
        let compacted = false;
        for (const [key, batches] of buckets) {
            // Only compact buckets with multiple batches
            if (batches.length <= 1) {
                compactedBatches.push(...batches);
                continue;
            }
            const [scope, branch] = key.split(":");
            // Download all ops in this bucket
            const allOps = [];
            for (const batch of batches) {
                try {
                    const data = await this.downloadData(batch.reference);
                    const ops = JSON.parse(new TextDecoder().decode(data));
                    allOps.push(...ops);
                }
                catch { /* skip unreadable batches */ }
            }
            if (allOps.length === 0)
                continue;
            // Dedup and sort
            allOps.sort((a, b) => a.index - b.index);
            const seen = new Set();
            const deduped = allOps.filter((op) => {
                if (seen.has(op.index))
                    return false;
                seen.add(op.index);
                return true;
            });
            // Upload merged ops as one batch
            const { reference } = await this.uploadData(JSON.stringify(deduped));
            const startIndex = deduped[0].index;
            const endIndex = deduped[deduped.length - 1].index;
            compactedBatches.push({
                reference,
                scope,
                branch,
                startIndex,
                endIndex,
                timestamp: new Date().toISOString(),
            });
            manifest.latestRevision[scope] = Math.max(manifest.latestRevision[scope] ?? -1, endIndex);
            compacted = true;
        }
        if (!compacted)
            return false;
        manifest.operationBatches = compactedBatches;
        manifest.updatedAt = new Date().toISOString();
        await this.updateManifest(documentId, manifest);
        return true;
    }
    // ═══════════════════════════════════════════════════════════════
    // User Manifest
    // ═══════════════════════════════════════════════════════════════
    async readUserManifest(address) {
        if (this.useFeedMode) {
            const topic = this.userTopic(address);
            const owner = this.getOwnerAddress();
            try {
                return await this.readFeedJson(topic, owner);
            }
            catch {
                return null;
            }
        }
        const key = `user:${address.toLowerCase()}`;
        const reference = this.manifestIndex.get(key);
        if (!reference)
            return null;
        try {
            const data = await this.downloadData(reference);
            return JSON.parse(new TextDecoder().decode(data));
        }
        catch {
            return null;
        }
    }
    async updateUserManifest(address, manifest, options) {
        const payload = JSON.stringify(manifest);
        if (this.useFeedMode) {
            const topic = this.userTopic(address);
            const { reference, tagUid } = await this.uploadData(payload, {
                tracked: options?.tracked,
            });
            await this.writeFeedPayload(topic, reference);
            return { tagUid };
        }
        else {
            const { reference } = await this.uploadData(payload);
            this.manifestIndex.set(`user:${address.toLowerCase()}`, reference);
            return {};
        }
    }
    // ═══════════════════════════════════════════════════════════════
    // Drive Manifest (hierarchical v2)
    // ═══════════════════════════════════════════════════════════════
    async readDriveManifest(driveId) {
        if (!this.useFeedMode)
            return null;
        const topic = this.driveTopic(driveId);
        const owner = this.getOwnerAddress();
        try {
            return await this.readFeedJson(topic, owner);
        }
        catch {
            return null;
        }
    }
    async updateDriveManifest(driveId, manifest) {
        if (!this.useFeedMode)
            return;
        const topic = this.driveTopic(driveId);
        const { reference } = await this.uploadData(JSON.stringify(manifest));
        await this.writeFeedPayload(topic, reference);
    }
    // ═══════════════════════════════════════════════════════════════
    // Identity & Node Info
    // ═══════════════════════════════════════════════════════════════
    getOwnerAddress() {
        if (!this.bee.signer)
            throw new Error("No signer configured on Bee instance");
        const hex = this.bee.signer.publicKey().address().toHex();
        return hex.startsWith("0x") ? hex : `0x${hex}`;
    }
    cachedBeeNodePubKey = null;
    async getBeeNodePublicKey() {
        if (this.cachedBeeNodePubKey)
            return this.cachedBeeNodePubKey;
        const response = await fetch(`${this.bee.url}/addresses`);
        if (!response.ok)
            throw new Error(`Failed to get Bee node addresses: ${response.status}`);
        const data = (await response.json());
        this.cachedBeeNodePubKey = data.publicKey;
        return data.publicKey;
    }
    async getNodeWallet() {
        const response = await fetch(`${this.bee.url}/wallet`);
        if (!response.ok)
            throw new Error(`Failed to get Bee wallet: ${response.status}`);
        const data = (await response.json());
        return { address: data.walletAddress, xBZZ: data.bzzBalance, xDAI: data.nativeTokenBalance };
    }
    async isHealthy() {
        try {
            const health = await this.bee.getHealth();
            return health.status === "ok";
        }
        catch {
            return false;
        }
    }
    // ═══════════════════════════════════════════════════════════════
    // Upload Confirmation (Tag Tracking)
    // ═══════════════════════════════════════════════════════════════
    /**
     * Get the current status of an upload tag.
     * Returns chunk-level progress: split, seen, stored, sent, synced.
     */
    async getTagStatus(tagUid) {
        const tag = await this.bee.retrieveTag(tagUid);
        return {
            uid: tag.uid,
            split: tag.split,
            seen: tag.seen,
            stored: tag.stored,
            sent: tag.sent,
            synced: tag.synced,
            done: tag.split > 0 && tag.synced >= tag.split,
        };
    }
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
    async waitForConfirmation(tagUid, timeoutMs = 60_000, intervalMs = 2_000, onProgress) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const status = await this.getTagStatus(tagUid);
            if (status.split > 0) {
                const percent = Math.round((status.synced / status.split) * 100);
                onProgress?.({ synced: status.synced, total: status.split, percent });
                if (status.done) {
                    return { synced: status.synced, total: status.split, durationMs: Date.now() - start };
                }
            }
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        const final = await this.getTagStatus(tagUid);
        throw new Error(`Upload confirmation timed out after ${timeoutMs}ms. ` +
            `Progress: ${final.synced}/${final.split} chunks synced.`);
    }
    // ═══════════════════════════════════════════════════════════════
    // Rich Node Status
    // ═══════════════════════════════════════════════════════════════
    /**
     * Get detailed node status snapshot.
     * Much richer than isHealthy() — includes mode, peers, sync rate, reachability.
     */
    async getNodeStatus() {
        const response = await fetch(`${this.bee.url}/status`);
        if (!response.ok)
            throw new Error(`Failed to get node status: ${response.status}`);
        const data = (await response.json());
        return {
            overlay: data.overlay ?? "",
            beeMode: data.beeMode ?? "unknown",
            isReachable: data.isReachable ?? false,
            connectedPeers: data.connectedPeers ?? 0,
            neighborhoodSize: data.neighborhoodSize ?? 0,
            reserveSize: data.reserveSize ?? 0,
            pullsyncRate: data.pullsyncRate ?? 0,
            storageRadius: data.storageRadius ?? 0,
        };
    }
    // ═══════════════════════════════════════════════════════════════
    // Content Availability (Stewardship)
    // ═══════════════════════════════════════════════════════════════
    /**
     * Check if content is still retrievable from the Swarm network.
     * Returns true if the content can be downloaded, false if chunks are missing.
     */
    async isContentAvailable(reference) {
        try {
            const response = await fetch(`${this.bee.url}/stewardship/${reference}`);
            if (!response.ok)
                return false;
            const data = (await response.json());
            return data.isRetrievable ?? false;
        }
        catch {
            return false;
        }
    }
    /**
     * Re-upload content that may no longer be available in the network.
     * Uses the current stamp to re-stamp the chunks.
     */
    async reuploadContent(reference) {
        const response = await fetch(`${this.bee.url}/stewardship/${reference}`, {
            method: "PUT",
            headers: { "swarm-postage-batch-id": this.batchId },
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to re-upload content: ${text}`);
        }
    }
    async detectFeedSupport() {
        try {
            const topic = Topic.fromString("ph:probe:" + Date.now());
            const owner = this.getOwnerAddress();
            const reader = this.bee.makeFeedReader(topic, owner);
            await reader.downloadPayload();
            return true;
        }
        catch (error) {
            if (isNotImplementedError(error))
                return false;
            if (isNotFoundError(error))
                return true;
            return false;
        }
    }
    // ═══════════════════════════════════════════════════════════════
    // Manifest Index (bytes mode)
    // ═══════════════════════════════════════════════════════════════
    getManifestIndex() { return new Map(this.manifestIndex); }
    setManifestIndex(index) { this.manifestIndex = new Map(index); }
    /** Get feed index metadata from the last readFeedJson call.
     *  Useful for knowing where you are in the feed sequence. */
    getLastFeedIndex() {
        return { feedIndex: this.lastFeedIndex, feedIndexNext: this.lastFeedIndexNext };
    }
    // ═══════════════════════════════════════════════════════════════
    // Delegation: Stamp methods (backward compatibility)
    // ═══════════════════════════════════════════════════════════════
    async getStampStatus() { return this.stamps.getStampStatus(); }
    async topUpStamp(amount) { return this.stamps.topUpStamp(amount); }
    async expandStamp(newDepth) { return this.stamps.expandStamp(newDepth); }
    async getStoragePrice() { return this.stamps.getStoragePrice(); }
    async getBzzUsdPrice() { return getBzzUsdPrice(); }
    async estimateStampCost(depth, days) { return this.stamps.estimateStampCost(depth, days); }
    async getStampOptions() { return this.stamps.getStampOptions(); }
    async getBucketUtilization() { return this.stamps.getBucketUtilization(); }
    async createStamp(amount, depth, options) { return this.stamps.createStamp(amount, depth, options); }
    // ═══════════════════════════════════════════════════════════════
    // Delegation: Share/Profile methods (backward compatibility)
    // ═══════════════════════════════════════════════════════════════
    async publishPublicProfile(addr, profile) { return this.sharing.publishPublicProfile(addr, profile); }
    async readPublicProfile(addr) { return this.sharing.readPublicProfile(addr); }
    async uploadSharedData(data, recipientBeeNodePubKey) { return this.sharing.uploadSharedData(data, recipientBeeNodePubKey); }
    async downloadSharedData(ref, publisherBeeNodePubKey, actHistoryAddress) { return this.sharing.downloadSharedData(ref, publisherBeeNodePubKey, actHistoryAddress); }
    /** @deprecated Legacy v1 download for migration — uses insecure deriveShareKey */
    /** @deprecated Legacy v1 download for migration — uses insecure deriveShareKey */
    async legacyDownloadSharedData(ref, sender, recipient) { return this.sharing.legacyDownloadSharedData(ref, sender, recipient); }
    async writeShareManifest(sender, recipient, manifest) { return this.sharing.writeShareManifest(sender, recipient, manifest); }
    async readShareManifest(sender, recipient) { return this.sharing.readShareManifest(sender, recipient); }
    /** @deprecated Use getNodeWallet() instead */
    async getNodeWalletAddress() { return (await this.getNodeWallet()).address; }
    /** @deprecated Use getNodeWallet() instead */
    async getNodeBalances() { const w = await this.getNodeWallet(); return { xBZZ: w.xBZZ, xDAI: w.xDAI }; }
    // ═══════════════════════════════════════════════════════════════
    // Topic Helpers (public — used by ShareManager)
    // ═══════════════════════════════════════════════════════════════
    documentTopic(documentId) {
        return Topic.fromString(`${this.feedTopicPrefix}:doc:${documentId}`);
    }
    userTopic(address) {
        return Topic.fromString(`${this.feedTopicPrefix}:user:${address.toLowerCase()}`);
    }
    profileTopic(address) {
        return Topic.fromString(`${this.feedTopicPrefix}:profile:${address.toLowerCase()}`);
    }
    shareTopic(fromAddress, toAddress) {
        return Topic.fromString(`${this.feedTopicPrefix}:share:${fromAddress.toLowerCase()}:${toAddress.toLowerCase()}`);
    }
    driveTopic(driveId) {
        return Topic.fromString(`${this.feedTopicPrefix}:drive:${driveId}`);
    }
    // ═══════════════════════════════════════════════════════════════
    // Feed Operations (public — used by ShareManager)
    // ═══════════════════════════════════════════════════════════════
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
    async readFeedJson(topic, ownerAddress, options) {
        const reader = this.bee.makeFeedReader(topic, ownerAddress);
        const result = await reader.downloadReference();
        const ref = result.reference.toHex();
        this.lastFeedIndex = result.feedIndex;
        this.lastFeedIndexNext = result.feedIndexNext;
        const data = options?.skipDecryption
            ? await this.downloadData(ref, { skipDecryption: true })
            : await this.downloadData(ref);
        return JSON.parse(new TextDecoder().decode(data));
    }
    /**
     * Write a /bytes reference to a feed using the native reference format.
     * Uses uploadReference (32-byte binary) — 69% smaller SOC than the legacy
     * uploadPayload approach (64-byte hex text).
     * Serializes writes per topic to prevent SOC conflicts.
     */
    async writeFeedPayload(topic, payload) {
        const topicHex = topic.toHex();
        const pending = this.feedWriteLocks.get(topicHex);
        if (pending)
            await pending.catch(() => { });
        const promise = (async () => {
            const writer = this.bee.makeFeedWriter(topic);
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    // Write the 32-byte reference natively (not as 64-char hex text)
                    await writer.uploadReference(this.batchId, payload);
                    return;
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (msg.includes("400") || msg.includes("Bad Request")) {
                        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
                        continue;
                    }
                    throw err;
                }
            }
            throw new Error("Feed write failed after 3 attempts");
        })();
        this.feedWriteLocks.set(topicHex, promise);
        try {
            await promise;
        }
        finally {
            if (this.feedWriteLocks.get(topicHex) === promise) {
                this.feedWriteLocks.delete(topicHex);
            }
        }
    }
    // ─── Bytes mode (dev / testing) ────────────────────────────────
    async readManifestFromFeed(documentId) {
        const topic = this.documentTopic(documentId);
        const owner = this.getOwnerAddress();
        try {
            return await this.readFeedJson(topic, owner);
        }
        catch {
            return null;
        }
    }
    async updateManifestViaFeed(documentId, manifest) {
        const topic = this.documentTopic(documentId);
        const { reference } = await this.uploadData(JSON.stringify(manifest));
        await this.writeFeedPayload(topic, reference);
    }
    async readManifestFromBytes(documentId) {
        const reference = this.manifestIndex.get(documentId);
        if (!reference)
            return null;
        try {
            const data = await this.downloadData(reference);
            return JSON.parse(new TextDecoder().decode(data));
        }
        catch {
            return null;
        }
    }
    async updateManifestViaBytes(documentId, manifest) {
        const payload = JSON.stringify(manifest);
        const { reference } = await this.uploadData(payload);
        this.manifestIndex.set(documentId, reference);
    }
}
// ─── Module-level helpers ───────────────────────────────────────
function isNotFoundError(error) {
    if (error && typeof error === "object") {
        const e = error;
        if ("status" in e && (e.status === 404 || e.status === 500))
            return true;
        if ("statusCode" in e && (e.statusCode === 404 || e.statusCode === 500))
            return true;
        if ("response" in e && e.response && typeof e.response === "object") {
            const resp = e.response;
            if (resp.status === 404 || resp.status === 500)
                return true;
        }
        if ("message" in e && typeof e.message === "string") {
            if (e.message.includes("404") || e.message.includes("Not Found"))
                return true;
            if (e.message.includes("Request failed with status code 404"))
                return true;
        }
    }
    return false;
}
function isNotImplementedError(error) {
    if (error && typeof error === "object" && "status" in error) {
        return error.status === 501;
    }
    return false;
}
//# sourceMappingURL=swarm-client.js.map