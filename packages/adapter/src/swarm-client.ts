import { Bee, Topic } from "@ethersphere/bee-js";
import type {
  SwarmDocumentManifest,
  SwarmDriveManifest,
  SwarmUserManifest,
  SwarmPublicProfile,
  ShareManifest,
  StampStatus,
} from "./types.js";
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
  private readonly bee: Bee;
  private readonly batchId: string;
  private readonly useFeedMode: boolean;
  private readonly feedTopicPrefix: string;
  /** The wallet-derived key used for app-layer AES-256-GCM encryption */
  private readonly encryptionKey: string;
  /** Whether to encrypt data before upload. Default: true */
  private readonly useEncryption: boolean;

  /**
   * In-memory index: documentId -> latest manifest reference.
   * Used in bytes mode when feeds are not available.
   */
  private manifestIndex: Map<string, string> = new Map();

  /** Per-topic write lock — serializes feed writes to prevent concurrent index conflicts */
  private feedWriteLocks: Map<string, Promise<void>> = new Map();

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
  }) {
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
  async uploadData(
    data: string | Uint8Array,
    options?: {
      act?: boolean;
      actHistoryAddress?: string;
      skipEncryption?: boolean;
      /** Track upload progress with a tag. Returns tagUid for polling via waitForConfirmation(). */
      tracked?: boolean;
      /** Use deferred upload (store locally first, push to network in background).
       *  Faster upload — returns immediately. Use with tracked:true to get confirmation. */
      deferred?: boolean;
    },
  ): Promise<{ reference: string; historyAddress?: string; tagUid?: number }> {
    let payload: string | Uint8Array = data;

    if (this.useEncryption && !options?.skipEncryption) {
      payload = await encrypt(data, this.encryptionKey);
    }

    // Create a tag for upload tracking if requested
    let tag: number | undefined;
    if (options?.tracked || options?.deferred) {
      const created = await this.bee.createTag();
      tag = created.uid;
    }

    const result = await this.bee.uploadData(this.batchId, payload, {
      act: options?.act,
      actHistoryAddress: options?.actHistoryAddress,
      tag,
      deferred: options?.deferred,
    });
    const historyRef = (result.historyAddress as any)?.value ?? result.historyAddress;
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
  async downloadData(
    reference: string,
    options?: {
      actPublisher?: string;
      actHistoryAddress?: string;
      actTimestamp?: number;
      skipDecryption?: boolean;
    },
  ): Promise<Uint8Array> {
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
  async uploadRawData(data: Uint8Array): Promise<{ reference: string }> {
    const result = await this.bee.uploadData(this.batchId, data);
    return { reference: result.reference.toHex() };
  }

  /**
   * Download raw bytes without SwarmClient decryption (for ShareManager).
   * The caller handles its own decryption with the shared key.
   */
  async downloadRawData(reference: string): Promise<Uint8Array> {
    const raw = await this.bee.downloadData(reference);
    return raw.toUint8Array();
  }

  // ═══════════════════════════════════════════════════════════════
  // ACT Access Control
  // ═══════════════════════════════════════════════════════════════

  async grantAccess(
    granteeRef: string,
    historyRef: string,
    publicKeys: string[],
  ): Promise<{ ref: string; historyRef: string }> {
    const result = await this.bee.patchGrantees(
      this.batchId, granteeRef, historyRef, { add: publicKeys },
    );
    return { ref: result.ref.toHex(), historyRef: result.historyref.toHex() };
  }

  async revokeAccess(
    granteeRef: string,
    historyRef: string,
    publicKeys: string[],
  ): Promise<{ ref: string; historyRef: string }> {
    const result = await this.bee.patchGrantees(
      this.batchId, granteeRef, historyRef, { revoke: publicKeys },
    );
    return { ref: result.ref.toHex(), historyRef: result.historyref.toHex() };
  }

  async createGrantees(publicKeys: string[]): Promise<{ ref: string; historyRef: string }> {
    const result = await this.bee.createGrantees(this.batchId, publicKeys);
    return { ref: result.ref.toHex(), historyRef: result.historyref.toHex() };
  }

  async getGrantees(granteeRef: string): Promise<string[]> {
    const result = await this.bee.getGrantees(granteeRef);
    return result.grantees.map((pk: { toCompressedHex: () => string }) => pk.toCompressedHex());
  }

  // ═══════════════════════════════════════════════════════════════
  // Document Manifest
  // ═══════════════════════════════════════════════════════════════

  async readManifest(documentId: string): Promise<SwarmDocumentManifest | null> {
    if (this.useFeedMode) return this.readManifestFromFeed(documentId);
    return this.readManifestFromBytes(documentId);
  }

  async updateManifest(documentId: string, manifest: SwarmDocumentManifest): Promise<void> {
    if (this.useFeedMode) return this.updateManifestViaFeed(documentId, manifest);
    return this.updateManifestViaBytes(documentId, manifest);
  }

  /**
   * Compact a document's manifest by merging many small operation batches
   * into fewer large ones. Keeps recovery fast (fewer downloads).
   */
  async compactManifest(documentId: string, maxBatches: number = 20): Promise<boolean> {
    const manifest = await this.readManifest(documentId);
    if (!manifest || manifest.operationBatches.length <= maxBatches) return false;

    // Group batches by scope:branch to compact each bucket independently
    const buckets = new Map<string, typeof manifest.operationBatches>();
    for (const batch of manifest.operationBatches) {
      const key = `${batch.scope}:${batch.branch}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(batch);
      buckets.set(key, bucket);
    }

    const compactedBatches: typeof manifest.operationBatches = [];
    let compacted = false;

    for (const [key, batches] of buckets) {
      // Only compact buckets with multiple batches
      if (batches.length <= 1) {
        compactedBatches.push(...batches);
        continue;
      }

      const [scope, branch] = key.split(":");

      // Download all ops in this bucket
      const allOps: Array<{ index: number; action: unknown; id?: string }> = [];
      for (const batch of batches) {
        try {
          const data = await this.downloadData(batch.reference);
          const ops = JSON.parse(new TextDecoder().decode(data));
          allOps.push(...ops);
        } catch { /* skip unreadable batches */ }
      }

      if (allOps.length === 0) continue;

      // Dedup and sort
      allOps.sort((a, b) => a.index - b.index);
      const seen = new Set<number>();
      const deduped = allOps.filter((op) => {
        if (seen.has(op.index)) return false;
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

      manifest.latestRevision[scope] = Math.max(
        manifest.latestRevision[scope] ?? -1,
        endIndex,
      );
      compacted = true;
    }

    if (!compacted) return false;

    manifest.operationBatches = compactedBatches;
    manifest.updatedAt = new Date().toISOString();

    await this.updateManifest(documentId, manifest);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // User Manifest
  // ═══════════════════════════════════════════════════════════════

  async readUserManifest(address: string): Promise<SwarmUserManifest | null> {
    if (this.useFeedMode) {
      const topic = this.userTopic(address);
      const owner = this.getOwnerAddress();
      try {
        return await this.readFeedJson<SwarmUserManifest>(topic, owner);
      } catch { return null; }
    }
    const key = `user:${address.toLowerCase()}`;
    const reference = this.manifestIndex.get(key);
    if (!reference) return null;
    try {
      const data = await this.downloadData(reference);
      return JSON.parse(new TextDecoder().decode(data)) as SwarmUserManifest;
    } catch { return null; }
  }

  async updateUserManifest(address: string, manifest: SwarmUserManifest): Promise<void> {
    const payload = JSON.stringify(manifest);
    if (this.useFeedMode) {
      const topic = this.userTopic(address);
      const { reference } = await this.uploadData(payload);
      await this.writeFeedPayload(topic, reference);
    } else {
      const { reference } = await this.uploadData(payload);
      this.manifestIndex.set(`user:${address.toLowerCase()}`, reference);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Drive Manifest (hierarchical v2)
  // ═══════════════════════════════════════════════════════════════

  async readDriveManifest(driveId: string): Promise<SwarmDriveManifest | null> {
    if (!this.useFeedMode) return null;
    const topic = this.driveTopic(driveId);
    const owner = this.getOwnerAddress();
    try {
      return await this.readFeedJson<SwarmDriveManifest>(topic, owner);
    } catch { return null; }
  }

  async updateDriveManifest(driveId: string, manifest: SwarmDriveManifest): Promise<void> {
    if (!this.useFeedMode) return;
    const topic = this.driveTopic(driveId);
    const { reference } = await this.uploadData(JSON.stringify(manifest));
    await this.writeFeedPayload(topic, reference);
  }

  // ═══════════════════════════════════════════════════════════════
  // Identity & Node Info
  // ═══════════════════════════════════════════════════════════════

  getOwnerAddress(): string {
    if (!this.bee.signer) throw new Error("No signer configured on Bee instance");
    const hex = this.bee.signer.publicKey().address().toHex();
    return hex.startsWith("0x") ? hex : `0x${hex}`;
  }

  async getBeeNodePublicKey(): Promise<string> {
    const response = await fetch(`${this.bee.url}/addresses`);
    if (!response.ok) throw new Error(`Failed to get Bee node addresses: ${response.status}`);
    const data = (await response.json()) as { publicKey: string };
    return data.publicKey;
  }

  async getNodeWallet(): Promise<{ address: string; xBZZ: string; xDAI: string }> {
    const response = await fetch(`${this.bee.url}/wallet`);
    if (!response.ok) throw new Error(`Failed to get Bee wallet: ${response.status}`);
    const data = (await response.json()) as {
      walletAddress: string; bzzBalance: string; nativeTokenBalance: string;
    };
    return { address: data.walletAddress, xBZZ: data.bzzBalance, xDAI: data.nativeTokenBalance };
  }

  async isHealthy(): Promise<boolean> {
    try {
      const health = await this.bee.getHealth();
      return health.status === "ok";
    } catch { return false; }
  }

  // ═══════════════════════════════════════════════════════════════
  // Upload Confirmation (Tag Tracking)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get the current status of an upload tag.
   * Returns chunk-level progress: split, seen, stored, sent, synced.
   */
  async getTagStatus(tagUid: number): Promise<{
    uid: number;
    split: number;
    seen: number;
    stored: number;
    sent: number;
    synced: number;
    done: boolean;
  }> {
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
  async waitForConfirmation(
    tagUid: number,
    timeoutMs = 60_000,
    intervalMs = 2_000,
    onProgress?: (status: { synced: number; total: number; percent: number }) => void,
  ): Promise<{ synced: number; total: number; durationMs: number }> {
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
    throw new Error(
      `Upload confirmation timed out after ${timeoutMs}ms. ` +
      `Progress: ${final.synced}/${final.split} chunks synced.`,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Rich Node Status
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get detailed node status snapshot.
   * Much richer than isHealthy() — includes mode, peers, sync rate, reachability.
   */
  async getNodeStatus(): Promise<{
    overlay: string;
    beeMode: "light" | "full" | "dev" | "ultra-light" | "unknown";
    isReachable: boolean;
    connectedPeers: number;
    neighborhoodSize: number;
    reserveSize: number;
    pullsyncRate: number;
    storageRadius: number;
  }> {
    const response = await fetch(`${this.bee.url}/status`);
    if (!response.ok) throw new Error(`Failed to get node status: ${response.status}`);
    const data = (await response.json()) as Record<string, unknown>;
    return {
      overlay: (data.overlay as string) ?? "",
      beeMode: (data.beeMode as string as "full") ?? "unknown",
      isReachable: (data.isReachable as boolean) ?? false,
      connectedPeers: (data.connectedPeers as number) ?? 0,
      neighborhoodSize: (data.neighborhoodSize as number) ?? 0,
      reserveSize: (data.reserveSize as number) ?? 0,
      pullsyncRate: (data.pullsyncRate as number) ?? 0,
      storageRadius: (data.storageRadius as number) ?? 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Content Availability (Stewardship)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if content is still retrievable from the Swarm network.
   * Returns true if the content can be downloaded, false if chunks are missing.
   */
  async isContentAvailable(reference: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.bee.url}/stewardship/${reference}`);
      if (!response.ok) return false;
      const data = (await response.json()) as { isRetrievable?: boolean };
      return data.isRetrievable ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Re-upload content that may no longer be available in the network.
   * Uses the current stamp to re-stamp the chunks.
   */
  async reuploadContent(reference: string): Promise<void> {
    const response = await fetch(`${this.bee.url}/stewardship/${reference}`, {
      method: "PUT",
      headers: { "swarm-postage-batch-id": this.batchId },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to re-upload content: ${text}`);
    }
  }

  async detectFeedSupport(): Promise<boolean> {
    try {
      const topic = Topic.fromString("ph:probe:" + Date.now());
      const owner = this.getOwnerAddress();
      const reader = this.bee.makeFeedReader(topic, owner);
      await reader.downloadPayload();
      return true;
    } catch (error: unknown) {
      if (isNotImplementedError(error)) return false;
      if (isNotFoundError(error)) return true;
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Manifest Index (bytes mode)
  // ═══════════════════════════════════════════════════════════════

  getManifestIndex(): Map<string, string> { return new Map(this.manifestIndex); }
  setManifestIndex(index: Map<string, string>): void { this.manifestIndex = new Map(index); }

  // ═══════════════════════════════════════════════════════════════
  // Delegation: Stamp methods (backward compatibility)
  // ═══════════════════════════════════════════════════════════════

  async getStampStatus(): Promise<StampStatus> { return this.stamps.getStampStatus(); }
  async topUpStamp(amount: bigint | string): Promise<void> { return this.stamps.topUpStamp(amount); }
  async expandStamp(newDepth: number): Promise<void> { return this.stamps.expandStamp(newDepth); }
  async getStoragePrice(): Promise<{ pricePerBlock: number; blockTime: number }> { return this.stamps.getStoragePrice(); }
  async getBzzUsdPrice(): Promise<number | null> { return getBzzUsdPrice(); }
  async estimateStampCost(depth: number, days: number) { return this.stamps.estimateStampCost(depth, days); }
  async getStampOptions() { return this.stamps.getStampOptions(); }
  async createStamp(amount: string, depth: number, options?: { immutable?: boolean }): Promise<string> { return this.stamps.createStamp(amount, depth, options); }

  // ═══════════════════════════════════════════════════════════════
  // Delegation: Share/Profile methods (backward compatibility)
  // ═══════════════════════════════════════════════════════════════

  async publishPublicProfile(addr: string, profile: SwarmPublicProfile): Promise<void> { return this.sharing.publishPublicProfile(addr, profile); }
  async readPublicProfile(addr: string): Promise<SwarmPublicProfile | null> { return this.sharing.readPublicProfile(addr); }
  async uploadSharedData(data: string | Uint8Array, sender: string, recipient: string) { return this.sharing.uploadSharedData(data, sender, recipient); }
  async downloadSharedData(ref: string, sender: string, recipient: string) { return this.sharing.downloadSharedData(ref, sender, recipient); }
  async writeShareManifest(sender: string, recipient: string, manifest: ShareManifest) { return this.sharing.writeShareManifest(sender, recipient, manifest); }
  async readShareManifest(sender: string, recipient: string) { return this.sharing.readShareManifest(sender, recipient); }

  /** @deprecated Use getNodeWallet() instead */
  async getNodeWalletAddress(): Promise<string> { return (await this.getNodeWallet()).address; }
  /** @deprecated Use getNodeWallet() instead */
  async getNodeBalances(): Promise<{ xBZZ: string; xDAI: string }> { const w = await this.getNodeWallet(); return { xBZZ: w.xBZZ, xDAI: w.xDAI }; }

  // ═══════════════════════════════════════════════════════════════
  // Topic Helpers (public — used by ShareManager)
  // ═══════════════════════════════════════════════════════════════

  documentTopic(documentId: string): Topic {
    return Topic.fromString(`${this.feedTopicPrefix}:doc:${documentId}`);
  }

  userTopic(address: string): Topic {
    return Topic.fromString(`${this.feedTopicPrefix}:user:${address.toLowerCase()}`);
  }

  profileTopic(address: string): Topic {
    return Topic.fromString(`${this.feedTopicPrefix}:profile:${address.toLowerCase()}`);
  }

  shareTopic(fromAddress: string, toAddress: string): Topic {
    return Topic.fromString(
      `${this.feedTopicPrefix}:share:${fromAddress.toLowerCase()}:${toAddress.toLowerCase()}`,
    );
  }

  driveTopic(driveId: string): Topic {
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
   * Falls back to downloadPayload (legacy hex text) for backward compatibility.
   */
  async readFeedJson<T>(
    topic: Topic,
    ownerAddress: string,
    options?: { skipDecryption?: boolean },
  ): Promise<T | null> {
    const reader = this.bee.makeFeedReader(topic, ownerAddress);

    // Use downloadReference to read the native 32-byte reference written by uploadReference.
    // This is the only read path — we always write with uploadReference now.
    const result = await reader.downloadReference();
    const ref = result.reference.toHex();

    const data = options?.skipDecryption
      ? await this.downloadData(ref, { skipDecryption: true })
      : await this.downloadData(ref);
    return JSON.parse(new TextDecoder().decode(data)) as T;
  }

  /**
   * Write a /bytes reference to a feed using the native reference format.
   * Uses uploadReference (32-byte binary) — 69% smaller SOC than the legacy
   * uploadPayload approach (64-byte hex text).
   * Serializes writes per topic to prevent SOC conflicts.
   */
  async writeFeedPayload(topic: Topic, payload: string): Promise<void> {
    const topicHex = topic.toHex();

    const pending = this.feedWriteLocks.get(topicHex);
    if (pending) await pending.catch(() => {});

    const promise = (async () => {
      const writer = this.bee.makeFeedWriter(topic);

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Write the 32-byte reference natively (not as 64-char hex text)
          await writer.uploadReference(this.batchId, payload);
          return;
        } catch (err: unknown) {
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
    } finally {
      if (this.feedWriteLocks.get(topicHex) === promise) {
        this.feedWriteLocks.delete(topicHex);
      }
    }
  }

  // ─── Bytes mode (dev / testing) ────────────────────────────────

  private async readManifestFromFeed(documentId: string): Promise<SwarmDocumentManifest | null> {
    const topic = this.documentTopic(documentId);
    const owner = this.getOwnerAddress();
    try {
      return await this.readFeedJson<SwarmDocumentManifest>(topic, owner);
    } catch { return null; }
  }

  private async updateManifestViaFeed(documentId: string, manifest: SwarmDocumentManifest): Promise<void> {
    const topic = this.documentTopic(documentId);
    const { reference } = await this.uploadData(JSON.stringify(manifest));
    await this.writeFeedPayload(topic, reference);
  }

  private async readManifestFromBytes(documentId: string): Promise<SwarmDocumentManifest | null> {
    const reference = this.manifestIndex.get(documentId);
    if (!reference) return null;
    try {
      const data = await this.downloadData(reference);
      return JSON.parse(new TextDecoder().decode(data)) as SwarmDocumentManifest;
    } catch { return null; }
  }

  private async updateManifestViaBytes(documentId: string, manifest: SwarmDocumentManifest): Promise<void> {
    const payload = JSON.stringify(manifest);
    const { reference } = await this.uploadData(payload);
    this.manifestIndex.set(documentId, reference);
  }
}

// ─── Module-level helpers ───────────────────────────────────────

function isNotFoundError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if ("status" in e && (e.status === 404 || e.status === 500)) return true;
    if ("statusCode" in e && (e.statusCode === 404 || e.statusCode === 500)) return true;
    if ("response" in e && e.response && typeof e.response === "object") {
      const resp = e.response as Record<string, unknown>;
      if (resp.status === 404 || resp.status === 500) return true;
    }
    if ("message" in e && typeof e.message === "string") {
      if (e.message.includes("404") || e.message.includes("Not Found")) return true;
      if (e.message.includes("Request failed with status code 404")) return true;
    }
  }
  return false;
}

function isNotImplementedError(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    return (error as { status: number }).status === 501;
  }
  return false;
}
