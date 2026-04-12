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
export declare class StampManager {
    private readonly bee;
    private readonly batchId;
    constructor(bee: Bee, batchId: string);
    /**
     * Get the current status of the postage stamp.
     */
    getStampStatus(): Promise<StampStatus>;
    /**
     * Get per-bucket utilization for the stamp.
     * Returns the fill level of each of the 65,536 buckets.
     * Useful for detecting "hot buckets" that are close to overflowing.
     *
     * @returns Array of bucket depths (how full each bucket is)
     */
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
    /**
     * Create a new postage stamp batch. The Bee node's wallet must be funded
     * with xBZZ and xDAI first.
     *
     * Defaults to MUTABLE stamps — recommended for Swarm Connect because:
     * - Feed updates reuse stamp slots (old feed indices get garbage collected)
     * - Prevents stamp exhaustion from frequent manifest writes
     * - Only the latest feed data is protected; old data expires naturally
     *
     * @param amount Per-chunk xBZZ allocation (determines duration)
     * @param depth Batch depth (determines capacity, minimum 17)
     * @param options.immutable Set to true for immutable stamp (default: false = mutable)
     */
    createStamp(amount: string, depth: number, options?: {
        immutable?: boolean;
    }): Promise<string>;
}
export declare function getBzzUsdPrice(): Promise<number | null>;
//# sourceMappingURL=stamp-manager.d.ts.map