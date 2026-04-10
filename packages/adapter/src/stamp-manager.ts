/**
 * Postage stamp management for Swarm.
 *
 * Handles stamp status, top-up, expansion, cost estimation,
 * preset options for the UI, and BZZ/USD price fetching.
 *
 * Extracted from SwarmClient to keep it focused on core data operations.
 */
import type { Bee } from "@ethersphere/bee-js";
import type { StampStatus } from "./types.js";

export class StampManager {
  constructor(
    private readonly bee: Bee,
    private readonly batchId: string,
  ) {}

  /**
   * Get the current status of the postage stamp.
   */
  async getStampStatus(): Promise<StampStatus> {
    const batch = await this.bee.getPostageBatch(this.batchId);
    const ttlSeconds = batch.duration.toSeconds();

    const effectiveCapacityBytes = batch.size.toBytes();
    const remainingBytes = batch.remainingSize.toBytes();
    const usedBytes = effectiveCapacityBytes - remainingBytes;
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
    const bzzUsdPrice = await getBzzUsdPrice();
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

    const bzzPrice = await getBzzUsdPrice();
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
    sizeOptions: Array<{ depth: number; label: string; effectiveBytes: number }>;
    durationOptions: Array<{ days: number; label: string; amount: string }>;
  }> {
    const batch = await this.bee.getPostageBatch(this.batchId);
    const chainState = await this.bee.getChainState();
    const pricePerBlock = chainState.currentPrice;
    const blockTime = 5; // Gnosis Chain

    const sizeTable: Array<{ depth: number; label: string; effectiveBytes: number }> = [
      { depth: 19, label: "110 MB", effectiveBytes: 110 * 1_000_000 },
      { depth: 20, label: "680 MB", effectiveBytes: 680 * 1_000_000 },
      { depth: 21, label: "2.6 GB", effectiveBytes: 2_600_000_000 },
      { depth: 22, label: "7.7 GB", effectiveBytes: 7_700_000_000 },
      { depth: 23, label: "17 GB", effectiveBytes: 17_000_000_000 },
      { depth: 24, label: "43 GB", effectiveBytes: 43_000_000_000 },
      { depth: 25, label: "97 GB", effectiveBytes: 97_000_000_000 },
    ];

    const sizeOptions = sizeTable.filter((s) => s.depth >= batch.depth);

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

  /**
   * Create a new postage stamp batch. The Bee node's wallet must be funded
   * with xBZZ and xDAI first.
   * @param amount Per-chunk xBZZ allocation (determines duration)
   * @param depth Batch depth (determines capacity, minimum 17)
   */
  async createStamp(amount: string, depth: number): Promise<string> {
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
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Get xBZZ/USD market price from CoinGecko.
 * Returns null if the API is unreachable.
 */
export async function getBzzUsdPrice(): Promise<number | null> {
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

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "expired";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days} day${days !== 1 ? "s" : ""}`;
  if (hours > 0) return `${hours} hour${hours !== 1 ? "s" : ""}`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
}
