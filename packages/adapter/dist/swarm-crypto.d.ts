/**
 * Encrypt data with AES-256-GCM using the wallet-derived key.
 *
 * Output format: [3-byte prefix "SWE"] [12-byte IV] [ciphertext + GCM tag]
 *
 * @param data - Plaintext data (string or Uint8Array)
 * @param key - 32-byte encryption key (hex string with 0x prefix, from wallet derivation)
 * @returns Encrypted bytes
 */
export declare function encrypt(data: string | Uint8Array, key: string): Promise<Uint8Array>;
/**
 * Decrypt AES-256-GCM encrypted data.
 *
 * @param encrypted - Encrypted bytes (prefix + IV + ciphertext)
 * @param key - 32-byte decryption key (hex string with 0x prefix)
 * @returns Decrypted plaintext bytes
 * @throws If data is not encrypted, wrong key, or tampered
 */
export declare function decrypt(encrypted: Uint8Array, key: string): Promise<Uint8Array>;
/**
 * Check if data has the encrypted prefix.
 * Useful for handling mixed encrypted/unencrypted content during migration.
 */
export declare function isEncrypted(data: Uint8Array): boolean;
/**
 * Encrypt a JSON-serializable object.
 */
export declare function encryptJSON(obj: unknown, key: string): Promise<Uint8Array>;
/**
 * Decrypt and parse a JSON object.
 */
export declare function decryptJSON<T = unknown>(encrypted: Uint8Array, key: string): Promise<T>;
//# sourceMappingURL=swarm-crypto.d.ts.map