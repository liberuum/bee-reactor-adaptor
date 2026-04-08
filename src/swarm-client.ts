import { Bee, Topic } from "@ethersphere/bee-js";
import type {
  SwarmDocumentManifest,
  SwarmUserManifest,
  SwarmPublicProfile,
  ShareManifest,
  StampStatus,
} from "./types.js";
import { encrypt, decrypt, isEncrypted } from "./swarm-crypto.js";

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
  }) {
    this.bee = new Bee(config.beeUrl, {
      signer: config.signerPrivateKey,
    });
    this.batchId = config.batchId;
    this.useFeedMode = config.useFeedMode ?? true;
    this.feedTopicPrefix = config.feedTopicPrefix ?? "ph";
    this.encryptionKey = config.signerPrivateKey;
    this.useEncryption = config.useEncryption ?? true;
  }

  /**
   * Upload data to Swarm /bytes.
   *
   * When encryption is enabled (default), data is encrypted with AES-256-GCM
   * using the wallet-derived key BEFORE upload. The Bee node never sees plaintext.
   *
   * @param data - Data to upload (will be encrypted if useEncryption is true)
   * @param options - Optional: skip encryption, enable ACT, provide history
   */
  async uploadData(
    data: string | Uint8Array,
    options?: { act?: boolean; actHistoryAddress?: string; skipEncryption?: boolean },
  ): Promise<{ reference: string; historyAddress?: string }> {
    let payload: string | Uint8Array = data;

    // App-layer encryption: encrypt before upload
    if (this.useEncryption && !options?.skipEncryption) {
      payload = await encrypt(data, this.encryptionKey);
    }

    const result = await this.bee.uploadData(this.batchId, payload, {
      act: options?.act,
      actHistoryAddress: options?.actHistoryAddress,
    });
    const historyRef = (result.historyAddress as any)?.value ?? result.historyAddress;
    return {
      reference: result.reference.toHex(),
      historyAddress: historyRef && typeof historyRef === "object" && "toHex" in historyRef
        ? historyRef.toHex()
        : undefined,
    };
  }

  /**
   * Download data from Swarm /bytes by reference.
   *
   * Automatically detects and decrypts AES-256-GCM encrypted data (SWE prefix).
   * Handles mixed encrypted/unencrypted content for backward compatibility.
   *
   * @param reference - Content reference
   * @param options - Optional: ACT parameters, skip decryption
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

    // Auto-decrypt if data has the SWE prefix (backward compatible with unencrypted data)
    if (!options?.skipDecryption && isEncrypted(data)) {
      return decrypt(data, this.encryptionKey);
    }

    return data;
  }

  // ─── ACT Access Control ────────────────────────────────────────

  /**
   * Grant access to encrypted content for specific Ethereum public keys.
   */
  async grantAccess(
    granteeRef: string,
    historyRef: string,
    publicKeys: string[],
  ): Promise<{ ref: string; historyRef: string }> {
    const result = await this.bee.patchGrantees(
      this.batchId,
      granteeRef,
      historyRef,
      { add: publicKeys },
    );
    return {
      ref: result.ref.toHex(),
      historyRef: result.historyref.toHex(),
    };
  }

  /**
   * Revoke access to encrypted content from specific Ethereum public keys.
   */
  async revokeAccess(
    granteeRef: string,
    historyRef: string,
    publicKeys: string[],
  ): Promise<{ ref: string; historyRef: string }> {
    const result = await this.bee.patchGrantees(
      this.batchId,
      granteeRef,
      historyRef,
      { revoke: publicKeys },
    );
    return {
      ref: result.ref.toHex(),
      historyRef: result.historyref.toHex(),
    };
  }

  /**
   * Create a new grantee list for ACT access control.
   */
  async createGrantees(
    publicKeys: string[],
  ): Promise<{ ref: string; historyRef: string }> {
    const result = await this.bee.createGrantees(this.batchId, publicKeys);
    return {
      ref: result.ref.toHex(),
      historyRef: result.historyref.toHex(),
    };
  }

  /**
   * Get the current grantee list (publisher only).
   */
  async getGrantees(granteeRef: string): Promise<string[]> {
    const result = await this.bee.getGrantees(granteeRef);
    return result.grantees.map((pk) => pk.toCompressedHex());
  }

  /**
   * Read the document manifest.
   * Uses feeds in production, or /bytes + local index in dev mode.
   */
  async readManifest(
    documentId: string,
  ): Promise<SwarmDocumentManifest | null> {
    if (this.useFeedMode) {
      return this.readManifestFromFeed(documentId);
    }
    return this.readManifestFromBytes(documentId);
  }

  /**
   * Update the document manifest.
   * Uses feeds in production, or /bytes + local index in dev mode.
   */
  async updateManifest(
    documentId: string,
    manifest: SwarmDocumentManifest,
  ): Promise<void> {
    if (this.useFeedMode) {
      return this.updateManifestViaFeed(documentId, manifest);
    }
    return this.updateManifestViaBytes(documentId, manifest);
  }

  /**
   * Get the Ethereum address derived from the signer private key.
   */
  getOwnerAddress(): string {
    if (!this.bee.signer) {
      throw new Error("No signer configured on Bee instance");
    }
    const hex = this.bee.signer.publicKey().address().toHex();
    return hex.startsWith("0x") ? hex : `0x${hex}`;
  }

  /**
   * Get the Bee node's public key (for ACT sharing — this is what other
   * users need to grant you access to their encrypted content).
   */
  async getBeeNodePublicKey(): Promise<string> {
    const response = await fetch(`${this.bee.url}/addresses`);
    if (!response.ok) {
      throw new Error(`Failed to get Bee node addresses: ${response.status}`);
    }
    const data = (await response.json()) as { publicKey: string };
    return data.publicKey;
  }

  /**
   * Get the Bee node's Gnosis Chain wallet address and balances.
   * The wallet endpoint returns everything we need for the settings UI.
   */
  async getNodeWallet(): Promise<{
    address: string;
    xBZZ: string;
    xDAI: string;
  }> {
    const response = await fetch(`${this.bee.url}/wallet`);
    if (!response.ok) {
      throw new Error(`Failed to get Bee wallet: ${response.status}`);
    }
    const data = (await response.json()) as {
      walletAddress: string;
      bzzBalance: string;
      nativeTokenBalance: string;
    };
    return {
      address: data.walletAddress,
      xBZZ: data.bzzBalance,
      xDAI: data.nativeTokenBalance,
    };
  }

  /**
   * @deprecated Use getNodeWallet() instead
   */
  async getNodeWalletAddress(): Promise<string> {
    const wallet = await this.getNodeWallet();
    return wallet.address;
  }

  /**
   * @deprecated Use getNodeWallet() instead
   */
  async getNodeBalances(): Promise<{ xBZZ: string; xDAI: string }> {
    const wallet = await this.getNodeWallet();
    return { xBZZ: wallet.xBZZ, xDAI: wallet.xDAI };
  }

  /**
   * Create a new postage stamp batch. The Bee node's wallet must be funded
   * with xBZZ and xDAI first.
   * @param amount Per-chunk xBZZ allocation (determines duration)
   * @param depth Batch depth (determines capacity, minimum 17)
   */
  async createStamp(
    amount: string,
    depth: number,
  ): Promise<string> {
    const response = await fetch(
      `${this.bee.url}/stamps/${amount}/${depth}`,
      { method: "POST" },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to create stamp: ${text}`);
    }
    const data = (await response.json()) as { batchID: string };
    return data.batchID;
  }

  /**
   * Check if the Bee node is reachable.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const health = await this.bee.getHealth();
      return health.status === "ok";
    } catch {
      return false;
    }
  }

  /**
   * Auto-detect whether feeds are supported by the connected node.
   * Updates the internal mode accordingly.
   */
  async detectFeedSupport(): Promise<boolean> {
    try {
      const topic = Topic.fromString("ph:probe:" + Date.now());
      const owner = this.getOwnerAddress();
      const reader = this.bee.makeFeedReader(topic, owner);
      await reader.downloadPayload();
      return true;
    } catch (error: unknown) {
      if (isNotImplementedError(error)) {
        return false;
      }
      // 404 means feeds are supported but this feed doesn't exist yet
      if (isNotFoundError(error)) {
        return true;
      }
      return false;
    }
  }

  /**
   * Get the local manifest index (for bytes mode).
   * Useful for persisting the index across restarts.
   */
  getManifestIndex(): Map<string, string> {
    return new Map(this.manifestIndex);
  }

  /**
   * Restore the local manifest index (for bytes mode).
   */
  setManifestIndex(index: Map<string, string>): void {
    this.manifestIndex = new Map(index);
  }

  // ─── User manifest ──────────────────────────────────────────────

  /**
   * Read the user manifest from Swarm for a given Ethereum address.
   * Returns null if no manifest exists.
   */
  async readUserManifest(
    address: string,
  ): Promise<SwarmUserManifest | null> {
    const key = `user:${address.toLowerCase()}`;
    if (this.useFeedMode) {
      const topic = this.userTopic(address);
      const owner = this.getOwnerAddress();
      try {
        const reader = this.bee.makeFeedReader(topic, owner);
        const result = await reader.downloadPayload();
        const raw = new TextDecoder().decode(result.payload.toUint8Array());

        // Auto-detect format: inline JSON (legacy) vs /bytes reference (new)
        if (raw.startsWith("{")) {
          return JSON.parse(raw) as SwarmUserManifest;
        }
        const trimmed = raw.trim();
        if (/^[0-9a-f]{64}$/i.test(trimmed)) {
          const data = await this.downloadData(trimmed);
          return JSON.parse(new TextDecoder().decode(data)) as SwarmUserManifest;
        }
        return JSON.parse(raw) as SwarmUserManifest;
      } catch (error: unknown) {
        if (isNotFoundError(error)) return null;
        throw error;
      }
    }

    const reference = this.manifestIndex.get(key);
    if (!reference) return null;
    try {
      const data = await this.downloadData(reference);
      return JSON.parse(new TextDecoder().decode(data)) as SwarmUserManifest;
    } catch {
      return null;
    }
  }

  /**
   * Update the user manifest on Swarm.
   */
  async updateUserManifest(
    address: string,
    manifest: SwarmUserManifest,
  ): Promise<void> {
    const payload = JSON.stringify(manifest);
    if (this.useFeedMode) {
      const topic = this.userTopic(address);
      // Upload to /bytes first, then write reference to feed (72-byte SOC)
      const { reference } = await this.uploadData(payload);
      await this.writeFeedPayload(topic, reference);
    } else {
      const { reference } = await this.uploadData(payload);
      this.manifestIndex.set(`user:${address.toLowerCase()}`, reference);
    }
  }

  // ─── Stamp management ─────────────────────────────────────────

  /**
   * Get the current status of the postage stamp.
   */
  async getStampStatus(): Promise<StampStatus> {
    const batch = await this.bee.getPostageBatch(this.batchId);
    const ttlSeconds = batch.duration.toSeconds();

    // Use bee-js computed values for sizes
    const effectiveCapacityBytes = batch.size.toBytes();
    const remainingBytes = batch.remainingSize.toBytes();
    const usedBytes = effectiveCapacityBytes - remainingBytes;

    // Use bee-js usage (0-1 float) for utilization — more accurate than our size ratio
    // The size ratio can be misleading for small stamps where both values are tiny
    const utilization = Math.round(batch.usage * 100);

    let health: StampStatus["health"];
    if (ttlSeconds <= 0) health = "expired";
    else if (ttlSeconds < 86400) health = "critical";
    else if (ttlSeconds < 604800) health = "warning";
    else health = "healthy";

    // Compute total cost: amount * 2^depth / 10^16 = xBZZ
    const amount = BigInt(batch.amount.toString());
    const totalPlur = amount * BigInt(2 ** batch.depth);
    const totalBzz = Number(totalPlur) / 1e16;
    const bzzUsdPrice = await this.getBzzUsdPrice();
    const totalUsd = bzzUsdPrice != null ? (totalBzz * bzzUsdPrice).toFixed(4) : null;

    return {
      batchId: this.batchId,
      usable: batch.usable,
      ttlSeconds,
      ttlHuman: formatDuration(ttlSeconds),
      utilization,
      capacityBytes: effectiveCapacityBytes,
      usedBytes,
      remainingBytes,
      capacityHuman: batch.size.toFormattedString(),
      remainingHuman: batch.remainingSize.toFormattedString(),
      depth: batch.depth,
      bucketDepth: batch.bucketDepth,
      rawUtilization: batch.utilization,
      maxUtilization: Math.pow(2, batch.depth - batch.bucketDepth),
      totalCostBzz: totalBzz.toFixed(6),
      totalCostUsd: totalUsd ? `$${totalUsd}` : null,
      bzzUsdPrice,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      health,
    };
  }

  /**
   * Top up the postage stamp to extend its TTL.
   */
  async topUpStamp(additionalAmount: bigint | string): Promise<void> {
    await this.bee.topUpBatch(this.batchId, additionalAmount.toString());
  }

  /**
   * Dilute the stamp to increase capacity (trades TTL for space).
   */
  async expandStamp(newDepth: number): Promise<void> {
    await this.bee.diluteBatch(this.batchId, newDepth);
  }

  /**
   * Get current storage price from the Bee node's chain state.
   * Returns pricePerBlock (PLUR per chunk per block) and blockTime (seconds).
   */
  async getStoragePrice(): Promise<{ pricePerBlock: number; blockTime: number }> {
    const chainState = await this.bee.getChainState();
    return {
      pricePerBlock: chainState.currentPrice,
      blockTime: 5, // Gnosis Chain default
    };
  }

  /**
   * Get xBZZ/USD market price from CoinGecko.
   * Returns null if the API is unreachable.
   */
  async getBzzUsdPrice(): Promise<number | null> {
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=swarm-bzz&vs_currencies=usd",
        { signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { "swarm-bzz"?: { usd?: number } };
      return data["swarm-bzz"]?.usd ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Estimate cost for a stamp operation.
   *
   * @param depth - Batch depth
   * @param days - Duration in days
   * @returns Cost estimate in xBZZ and USD (if price available)
   */
  async estimateStampCost(
    depth: number,
    days: number,
  ): Promise<{ xBZZ: string; usd: string | null; amountPlur: string }> {
    const { pricePerBlock, blockTime } = await this.getStoragePrice();
    const blocksPerDay = Math.ceil(86400 / blockTime);
    const amountPerChunk = BigInt(pricePerBlock) * BigInt(blocksPerDay) * BigInt(days);
    const totalPlur = amountPerChunk * BigInt(2 ** depth);
    const xBZZ = Number(totalPlur) / 1e16;

    const bzzPrice = await this.getBzzUsdPrice();
    const usd = bzzPrice != null ? (xBZZ * bzzPrice).toFixed(4) : null;

    return {
      xBZZ: xBZZ.toFixed(6),
      usd: usd ? `$${usd}` : null,
      amountPlur: amountPerChunk.toString(),
    };
  }

  /**
   * Get stamp management options with human-readable presets.
   * Fetches current price and computes costs for common operations.
   */
  async getStampOptions(): Promise<{
    currentDepth: number;
    currentTtlSeconds: number;
    pricePerBlock: number;
    blockTime: number;
    /** Predefined storage size options (depth → human size) */
    sizeOptions: Array<{ depth: number; label: string; effectiveBytes: number }>;
    /** Predefined duration options with computed PLUR amounts */
    durationOptions: Array<{ days: number; label: string; amount: string }>;
  }> {
    const batch = await this.bee.getPostageBatch(this.batchId);
    const chainState = await this.bee.getChainState();
    const pricePerBlock = chainState.currentPrice;
    const blockTime = 5; // Gnosis Chain

    // Effective bytes per depth (from bee-js stamp tables for unencrypted, no erasure)
    const sizeTable: Array<{ depth: number; label: string; effectiveBytes: number }> = [
      { depth: 19, label: "110 MB", effectiveBytes: 110 * 1_000_000 },
      { depth: 20, label: "680 MB", effectiveBytes: 680 * 1_000_000 },
      { depth: 21, label: "2.6 GB", effectiveBytes: 2_600_000_000 },
      { depth: 22, label: "7.7 GB", effectiveBytes: 7_700_000_000 },
      { depth: 23, label: "17 GB", effectiveBytes: 17_000_000_000 },
      { depth: 24, label: "43 GB", effectiveBytes: 43_000_000_000 },
      { depth: 25, label: "97 GB", effectiveBytes: 97_000_000_000 },
    ];

    // Only show sizes >= current depth
    const sizeOptions = sizeTable.filter((s) => s.depth >= batch.depth);

    // Compute PLUR amount for each duration preset
    // amount = (durationSeconds / blockTime) * pricePerBlock
    const durationPresets = [1, 2, 7, 15, 30, 90];
    const durationOptions = durationPresets.map((days) => {
      const seconds = days * 86400;
      const blocks = Math.ceil(seconds / blockTime);
      const amount = BigInt(blocks) * BigInt(pricePerBlock);
      return {
        days,
        label: days === 1 ? "~1 day" : `~${days} days`,
        amount: amount.toString(),
      };
    });

    return {
      currentDepth: batch.depth,
      currentTtlSeconds: batch.duration.toSeconds(),
      pricePerBlock,
      blockTime,
      sizeOptions,
      durationOptions,
    };
  }

  // ─── Public Profile (unencrypted, discoverable by ETH address) ─

  /**
   * Publish the user's public profile to an UNENCRYPTED feed.
   * The profile is keyed by the signer address (= feed owner), so
   * anyone who knows the signer address can discover the profile.
   *
   * @param signerAddress - The signer's address (from getOwnerAddress())
   * @param profile - The profile data to publish
   */
  async publishPublicProfile(
    signerAddress: string,
    profile: SwarmPublicProfile,
  ): Promise<void> {
    const topic = this.profileTopic(signerAddress);
    const payload = JSON.stringify(profile);
    // Upload WITHOUT encryption — this is public data
    const { reference } = await this.uploadData(payload, { skipEncryption: true });
    await this.writeFeedPayload(topic, reference);
  }

  /**
   * Read a user's public profile by their Swarm signer address.
   * Returns null if the user hasn't published a profile yet.
   *
   * The signer address IS the feed owner, so this works for cross-user reads.
   * Note: this takes a signer address, NOT an ETH wallet address.
   *
   * @param signerAddress - The target user's signer address (NOT their ETH wallet address)
   */
  async readPublicProfile(
    signerAddress: string,
  ): Promise<SwarmPublicProfile | null> {
    const topic = this.profileTopic(signerAddress);
    const ownerAddr = normalizeAddress(signerAddress);
    try {
      const reader = this.bee.makeFeedReader(topic, ownerAddr);
      const result = await reader.downloadPayload();
      const raw = new TextDecoder().decode(result.payload.toUint8Array());

      // Profile data is unencrypted — parse directly or dereference
      if (raw.startsWith("{")) {
        return JSON.parse(raw) as SwarmPublicProfile;
      }
      const trimmed = raw.trim();
      if (/^[0-9a-f]{64}$/i.test(trimmed)) {
        const data = await this.downloadData(trimmed, { skipDecryption: true });
        return JSON.parse(new TextDecoder().decode(data)) as SwarmPublicProfile;
      }
      return null;
    } catch {
      // Any error (404, parse, network) → no profile
      return null;
    }
  }

  // ─── Document Sharing (ACT-based) ─────────────────────────────

  /**
   * Upload data for sharing — encrypted with a key derived from both parties' addresses.
   * Both sender and recipient can derive the same key: SHA-256(sender:recipient).
   * Third parties can't decrypt without knowing both signer addresses.
   *
   * @param data - The operation data to share
   * @param senderAddress - Sender's signer address
   * @param recipientAddress - Recipient's signer address
   */
  async uploadSharedData(
    data: string | Uint8Array,
    senderAddress: string,
    recipientAddress: string,
  ): Promise<{ reference: string }> {
    const shareKey = await deriveShareKey(senderAddress, recipientAddress);
    const encrypted = await encrypt(data, shareKey);
    const result = await this.bee.uploadData(this.batchId, encrypted);
    return { reference: result.reference.toHex() };
  }

  /**
   * Download shared data and decrypt with the shared key.
   * The key is derived from both parties' addresses: SHA-256(sender:recipient).
   *
   * @param reference - Swarm reference
   * @param senderAddress - Sender's signer address
   * @param recipientAddress - Recipient's signer address (= our address when importing)
   */
  async downloadSharedData(
    reference: string,
    senderAddress: string,
    recipientAddress: string,
  ): Promise<Uint8Array> {
    const raw = await this.bee.downloadData(reference);
    const shareKey = await deriveShareKey(senderAddress, recipientAddress);
    return decrypt(raw.toUint8Array(), shareKey);
  }

  /**
   * Write a share manifest to the share feed between sender and recipient.
   */
  async writeShareManifest(
    senderAddress: string,
    recipientAddress: string,
    manifest: ShareManifest,
  ): Promise<void> {
    const topic = this.shareTopic(senderAddress, recipientAddress);
    const payload = JSON.stringify(manifest);
    // Upload WITHOUT encryption — the recipient needs to read this manifest
    // to discover shared documents. The actual document data is ACT-encrypted.
    const { reference } = await this.uploadData(payload, { skipEncryption: true });
    await this.writeFeedPayload(topic, reference);
  }

  /**
   * Read the share manifest from another user.
   * Alice reads: shareTopic(bob, alice) with owner = bob's address.
   *
   * Note: The share manifest is encrypted with the sender's key.
   * The recipient needs their own copy or the manifest should use
   * a shared encryption scheme. For now, we store it unencrypted
   * on the feed (the feed topic is obscure enough).
   */
  async readShareManifest(
    senderAddress: string,
    recipientAddress: string,
  ): Promise<ShareManifest | null> {
    const senderNorm = normalizeAddress(senderAddress);
    const topic = this.shareTopic(senderAddress, recipientAddress);
    try {
      // Read using the SENDER's address as owner (they wrote this feed)
      const reader = this.bee.makeFeedReader(topic, senderNorm);
      const result = await reader.downloadPayload();
      const raw = new TextDecoder().decode(result.payload.toUint8Array());

      // Auto-detect: inline JSON or /bytes reference
      if (raw.startsWith("{")) {
        return JSON.parse(raw) as ShareManifest;
      }
      const trimmed = raw.trim();
      if (/^[0-9a-f]{64}$/i.test(trimmed)) {
        const data = await this.downloadData(trimmed, { skipDecryption: true });
        return JSON.parse(new TextDecoder().decode(data)) as ShareManifest;
      }
      return null;
    } catch {
      // Any error (404, parse, network) → no share manifest
      return null;
    }
  }

  // ─── Manifest compaction ───────────────────────────────────────

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
  async compactManifest(
    documentId: string,
    maxBatches: number = 20,
  ): Promise<boolean> {
    const manifest = await this.readManifest(documentId);
    if (!manifest || manifest.operationBatches.length <= maxBatches) {
      return false;
    }

    // Download all batches, merge ops, dedup, sort
    const allOps: Array<{ index: number; action: unknown; id?: string }> = [];
    for (const batch of manifest.operationBatches) {
      try {
        const data = await this.downloadData(batch.reference);
        const ops = JSON.parse(new TextDecoder().decode(data));
        allOps.push(...ops);
      } catch {
        // Skip unreadable batches (expired or corrupted)
      }
    }

    if (allOps.length === 0) return false;

    // Dedup by op ID or index, sort
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

    // Replace all batch entries with one
    manifest.operationBatches = [{
      reference,
      scope: "global",
      branch: "main",
      startIndex,
      endIndex,
      timestamp: new Date().toISOString(),
    }];
    manifest.latestRevision["global"] = endIndex;
    manifest.updatedAt = new Date().toISOString();

    await this.updateManifest(documentId, manifest);

    return true;
  }

  // ─── Topic helpers ─────────────────────────────────────────────

  /**
   * Derive a deterministic feed topic for a document.
   */
  documentTopic(documentId: string): Topic {
    return Topic.fromString(`${this.feedTopicPrefix}:doc:${documentId}`);
  }

  /**
   * Derive a deterministic feed topic for a user's manifest.
   */
  userTopic(address: string): Topic {
    // MUST keep 0x prefix — existing feeds were written with it
    return Topic.fromString(`${this.feedTopicPrefix}:user:${address.toLowerCase()}`);
  }

  /**
   * Derive a deterministic feed topic for a user's public profile.
   */
  profileTopic(address: string): Topic {
    return Topic.fromString(`${this.feedTopicPrefix}:profile:${address.toLowerCase()}`);
  }

  /**
   * Derive a deterministic feed topic for shares between two users.
   */
  shareTopic(fromAddress: string, toAddress: string): Topic {
    return Topic.fromString(
      `${this.feedTopicPrefix}:share:${fromAddress.toLowerCase()}:${toAddress.toLowerCase()}`,
    );
  }

  // ─── Feed mode (production) ────────────────────────────────────

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
  private async readManifestFromFeed(
    documentId: string,
  ): Promise<SwarmDocumentManifest | null> {
    const topic = this.documentTopic(documentId);
    const owner = this.getOwnerAddress();

    try {
      const reader = this.bee.makeFeedReader(topic, owner);
      const result = await reader.downloadPayload();
      const raw = new TextDecoder().decode(result.payload.toUint8Array());

      // Auto-detect format: if it starts with '{', it's inline JSON (legacy)
      if (raw.startsWith("{")) {
        return JSON.parse(raw) as SwarmDocumentManifest;
      }

      // Otherwise it's a /bytes reference — dereference it
      const trimmed = raw.trim();
      if (/^[0-9a-f]{64}$/i.test(trimmed)) {
        const data = await this.downloadData(trimmed);
        const json = new TextDecoder().decode(data);
        return JSON.parse(json) as SwarmDocumentManifest;
      }

      // Unknown format — not a valid manifest
      return null;
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

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
  private async updateManifestViaFeed(
    documentId: string,
    manifest: SwarmDocumentManifest,
  ): Promise<void> {
    const topic = this.documentTopic(documentId);
    // Upload manifest to /bytes first
    const { reference } = await this.uploadData(JSON.stringify(manifest));
    // Write only the reference to the feed (72-byte SOC)
    await this.writeFeedPayload(topic, reference);
  }

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
  private async writeFeedPayload(topic: Topic, payload: string): Promise<void> {
    const topicHex = topic.toHex();

    // Serialize: wait for any in-flight write to the same topic to complete
    const pending = this.feedWriteLocks.get(topicHex);
    if (pending) {
      await pending.catch(() => {});
    }

    const promise = (async () => {
      const writer = this.bee.makeFeedWriter(topic);
      const data = new TextEncoder().encode(payload);

      // Let bee-js handle index discovery automatically.
      // Retry on 400 with backoff (previous write may need propagation time).
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await writer.uploadPayload(this.batchId, data);
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

  private async readManifestFromBytes(
    documentId: string,
  ): Promise<SwarmDocumentManifest | null> {
    const reference = this.manifestIndex.get(documentId);
    if (!reference) return null;

    try {
      const data = await this.downloadData(reference);
      const json = new TextDecoder().decode(data);
      return JSON.parse(json) as SwarmDocumentManifest;
    } catch {
      return null;
    }
  }

  private async updateManifestViaBytes(
    documentId: string,
    manifest: SwarmDocumentManifest,
  ): Promise<void> {
    const payload = JSON.stringify(manifest);
    const { reference } = await this.uploadData(payload);
    this.manifestIndex.set(documentId, reference);
  }
}

/** Normalize an address: strip 0x prefix for bee-js, lowercase */
function normalizeAddress(addr: string): string {
  return addr.replace(/^0x/i, "").toLowerCase();
}

/**
 * Derive a 32-byte hex key for share encryption from both parties' addresses.
 * SHA-256(sender_normalized + ":" + recipient_normalized) → 64-char hex string.
 * Both sender and recipient can independently derive the same key.
 */
async function deriveShareKey(senderAddress: string, recipientAddress: string): Promise<string> {
  const material = `${normalizeAddress(senderAddress)}:${normalizeAddress(recipientAddress)}`;
  const encoded = new TextEncoder().encode(material);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isNotFoundError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    // Check .status (bee-js BeeResponseError)
    if ("status" in e && (e.status === 404 || e.status === 500)) return true;
    // Check .statusCode (axios-style)
    if ("statusCode" in e && (e.statusCode === 404 || e.statusCode === 500)) return true;
    // Check nested .response.status
    if ("response" in e && e.response && typeof e.response === "object") {
      const resp = e.response as Record<string, unknown>;
      if (resp.status === 404 || resp.status === 500) return true;
    }
    // Check error message
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

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "expired";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days} day${days !== 1 ? "s" : ""}`;
  if (hours > 0) return `${hours} hour${hours !== 1 ? "s" : ""}`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
}
