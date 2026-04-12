/**
 * Shared byte-conversion utilities.
 *
 * Used by swarm-crypto.ts, wallet-signer.ts, and share-manager.ts.
 * Extracted here to avoid duplicating the same helpers across files.
 */
/** Convert a hex string (with or without 0x prefix) to Uint8Array */
export declare function hexToBytes(hex: string): Uint8Array;
/** Convert a Uint8Array to a lowercase hex string (no 0x prefix) */
export declare function bytesToHex(bytes: Uint8Array): string;
/** Concatenate multiple Uint8Arrays into one */
export declare function concatBytes(...arrays: Uint8Array[]): Uint8Array;
//# sourceMappingURL=bytes-utils.d.ts.map