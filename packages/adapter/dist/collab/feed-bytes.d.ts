/**
 * Shared low-level helpers used by CollabOpsFeed and CollabManifestFeed.
 *
 * - Feed index parsing that tolerates both `FeedIndex` objects (newer
 *   bee-js) and string/number forms (older builds).
 * - 32-byte hex ↔ Uint8Array conversion for the wrapper chunk format
 *   (64 bytes = actRef || actHist).
 *
 * These used to be duplicated per-file; consolidated here so a bug fix
 * lands in one place.
 */
/** Size of the wrapper chunk we upload to /bytes to carry `actRef ||
 *  actHistoryAddress` behind a 32-byte feed reference. */
export declare const WRAPPER_BYTES = 64;
export declare function parseFeedIndex(raw: unknown): number;
export declare function hexToBytes32(hex: string): Uint8Array;
export declare function bytes32ToHex(bytes: Uint8Array, offset?: number): string;
//# sourceMappingURL=feed-bytes.d.ts.map