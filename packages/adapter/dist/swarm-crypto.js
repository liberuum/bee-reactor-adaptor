/**
 * App-layer encryption for Swarm data using AES-256-GCM.
 *
 * Uses the user's wallet-derived key (from personal_sign → keccak256)
 * as the symmetric encryption key. Encryption happens before upload,
 * decryption after download — the Bee node never sees plaintext.
 *
 * This approach works with:
 * - Any Bee node (doesn't need to hold user keys)
 * - Public gateways (data is already encrypted)
 * - Multiple users on the same Switchboard (each has their own key)
 * - Cross-device (same wallet = same key)
 * - Node loss recovery (wallet derives the same key)
 */
const IV_LENGTH = 12; // AES-GCM standard IV length
const ENCRYPTED_PREFIX = new Uint8Array([0x53, 0x57, 0x45]); // "SWE" — Swarm Encrypted marker
/**
 * Encrypt data with AES-256-GCM using the wallet-derived key.
 *
 * Output format: [3-byte prefix "SWE"] [12-byte IV] [ciphertext + GCM tag]
 *
 * @param data - Plaintext data (string or Uint8Array)
 * @param key - 32-byte encryption key (hex string with 0x prefix, from wallet derivation)
 * @returns Encrypted bytes
 */
export async function encrypt(data, key) {
    const plaintext = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const keyBytes = hexToBytes(key);
    const cryptoKey = await crypto.subtle.importKey("raw", keyBytes.buffer, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext.buffer);
    // Prefix + IV + ciphertext (includes GCM auth tag)
    return concatBytes(ENCRYPTED_PREFIX, iv, new Uint8Array(ciphertext));
}
/**
 * Decrypt AES-256-GCM encrypted data.
 *
 * @param encrypted - Encrypted bytes (prefix + IV + ciphertext)
 * @param key - 32-byte decryption key (hex string with 0x prefix)
 * @returns Decrypted plaintext bytes
 * @throws If data is not encrypted, wrong key, or tampered
 */
export async function decrypt(encrypted, key) {
    if (!isEncrypted(encrypted)) {
        throw new Error("Data is not encrypted (missing SWE prefix)");
    }
    const keyBytes = hexToBytes(key);
    const iv = encrypted.slice(ENCRYPTED_PREFIX.length, ENCRYPTED_PREFIX.length + IV_LENGTH);
    const ciphertext = encrypted.slice(ENCRYPTED_PREFIX.length + IV_LENGTH);
    const cryptoKey = await crypto.subtle.importKey("raw", keyBytes.buffer, "AES-GCM", false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext.buffer);
    return new Uint8Array(plaintext);
}
/**
 * Check if data has the encrypted prefix.
 * Useful for handling mixed encrypted/unencrypted content during migration.
 */
export function isEncrypted(data) {
    if (data.length < ENCRYPTED_PREFIX.length + IV_LENGTH + 1)
        return false;
    return (data[0] === ENCRYPTED_PREFIX[0] &&
        data[1] === ENCRYPTED_PREFIX[1] &&
        data[2] === ENCRYPTED_PREFIX[2]);
}
/**
 * Encrypt a JSON-serializable object.
 */
export async function encryptJSON(obj, key) {
    return encrypt(JSON.stringify(obj), key);
}
/**
 * Decrypt and parse a JSON object.
 */
export async function decryptJSON(encrypted, key) {
    const plaintext = await decrypt(encrypted, key);
    return JSON.parse(new TextDecoder().decode(plaintext));
}
// ─── Helpers ─────────────────────────────────────────────────────
function hexToBytes(hex) {
    const h = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(h.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}
function concatBytes(...arrays) {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}
//# sourceMappingURL=swarm-crypto.js.map