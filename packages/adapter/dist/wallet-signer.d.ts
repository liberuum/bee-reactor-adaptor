/**
 * Minimal interface for an EIP-1193 Ethereum provider (MetaMask, etc.).
 * Accept this instead of hard-wiring to window.ethereum for testability.
 */
export interface EthereumProvider {
    request(args: {
        method: string;
        params?: unknown[];
    }): Promise<unknown>;
}
/**
 * The stored signer entry in IndexedDB.
 */
export interface SwarmSignerEntry {
    swarmPrivateKey: string;
    swarmPublicKey: string;
    ownerAddress: string;
    derivedAt: string;
}
/**
 * Build the deterministic message that the user signs to derive their Swarm key.
 * Includes domain separator to prevent cross-site key extraction.
 */
export declare function buildSignMessage(address: string, origin?: string): string;
/**
 * Derive a secp256k1 private key from an Ethereum wallet signature.
 * Uses keccak256(signature) to produce a deterministic 32-byte key.
 *
 * @param signature - The raw hex signature from personal_sign
 * @returns 32-byte hex private key (with 0x prefix)
 */
export declare function deriveSwarmKey(signature: string): string;
/**
 * Request a wallet signature and derive the Swarm key.
 * This is the main entry point for browser environments with window.ethereum.
 *
 * @param address - User's Ethereum address (from Renown login)
 * @param origin - The app origin for domain separation
 * @returns The derived SwarmSignerEntry
 */
export declare function requestSwarmKeyFromWallet(address: string, origin?: string, 
/** Injectable provider for testing. Defaults to window.ethereum. */
provider?: EthereumProvider): Promise<SwarmSignerEntry>;
/**
 * Load a cached Swarm signer from IndexedDB.
 * Returns null if not found or if the stored address doesn't match.
 */
export declare function loadCachedSwarmKey(address: string): Promise<SwarmSignerEntry | null>;
/**
 * Save a Swarm signer to IndexedDB for future sessions.
 */
export declare function cacheSwarmKey(entry: SwarmSignerEntry): Promise<void>;
/**
 * Clear the cached Swarm signer from IndexedDB.
 */
export declare function clearCachedSwarmKey(): Promise<void>;
/**
 * Get or derive the Swarm signer key.
 * Checks IndexedDB cache first. If not found, requests wallet signature.
 *
 * This is the main function to call from the SwarmConnectPlugin.
 */
export declare function getOrDeriveSwarmKey(address: string, origin?: string): Promise<SwarmSignerEntry>;
//# sourceMappingURL=wallet-signer.d.ts.map