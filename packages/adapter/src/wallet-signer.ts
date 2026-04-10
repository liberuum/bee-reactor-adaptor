/**
 * Derives a deterministic secp256k1 Swarm signer key from an Ethereum wallet
 * signature. The same wallet + same message always produces the same key,
 * enabling cross-device document access.
 *
 * Flow:
 * 1. User connects wallet (MetaMask, etc.)
 * 2. Signs a domain-specific message via personal_sign
 * 3. keccak256(signature) produces a 32-byte secp256k1 private key
 * 4. Key is cached in IndexedDB for seamless future sessions
 * 5. On browser data clear, key is re-derived on next login (same result)
 */
import { hexToBytes, bytesToHex } from "./bytes-utils.js";
import { Bytes, PrivateKey } from "@ethersphere/bee-js";

const SWARM_KEY_DB_NAME = "swarmKeyDB";
const SWARM_KEY_STORE_NAME = "keys";
const SWARM_KEY_ENTRY = "swarm-signer";

/**
 * Minimal interface for an EIP-1193 Ethereum provider (MetaMask, etc.).
 * Accept this instead of hard-wiring to window.ethereum for testability.
 */
export interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
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
export function buildSignMessage(address: string, origin?: string): string {
  return [
    "Authorize Swarm storage for Powerhouse Connect",
    `Address: ${address}`,
    `Origin: ${origin ?? "powerhouse-connect"}`,
    "This signature will be used to derive your Swarm encryption key.",
    "It does not authorize any blockchain transaction.",
  ].join("\n");
}

/**
 * Derive a secp256k1 private key from an Ethereum wallet signature.
 * Uses keccak256(signature) to produce a deterministic 32-byte key.
 *
 * @param signature - The raw hex signature from personal_sign
 * @returns 32-byte hex private key (with 0x prefix)
 */
export function deriveSwarmKey(signature: string): string {
  const sigBytes = hexToBytes(signature);
  const hash = keccak256(sigBytes);
  return "0x" + bytesToHex(hash);
}

/**
 * Request a wallet signature and derive the Swarm key.
 * This is the main entry point for browser environments with window.ethereum.
 *
 * @param address - User's Ethereum address (from Renown login)
 * @param origin - The app origin for domain separation
 * @returns The derived SwarmSignerEntry
 */
export async function requestSwarmKeyFromWallet(
  address: string,
  origin?: string,
  /** Injectable provider for testing. Defaults to window.ethereum. */
  provider?: EthereumProvider,
): Promise<SwarmSignerEntry> {
  const ethereum = provider ?? (globalThis as any).window?.ethereum;
  if (!ethereum) {
    throw new Error(
      "No Ethereum wallet found. Please install MetaMask or another Web3 wallet.",
    );
  }

  // Ensure wallet is connected (MetaMask requires eth_requestAccounts first)
  await ethereum.request({ method: "eth_requestAccounts" });

  const message = buildSignMessage(address, origin);
  const signature = await ethereum.request({
    method: "personal_sign",
    params: [
      "0x" + bytesToHex(new TextEncoder().encode(message)),
      address,
    ],
  }) as string;

  const swarmPrivateKey = deriveSwarmKey(signature);

  const pk = new PrivateKey(swarmPrivateKey);
  const swarmPublicKey = pk.publicKey().toCompressedHex();

  return {
    swarmPrivateKey,
    swarmPublicKey,
    ownerAddress: address,
    derivedAt: new Date().toISOString(),
  };
}

// ─── IndexedDB Cache ─────────────────────────────────────────────

/**
 * Load a cached Swarm signer from IndexedDB.
 * Returns null if not found or if the stored address doesn't match.
 */
export async function loadCachedSwarmKey(
  address: string,
): Promise<SwarmSignerEntry | null> {
  try {
    const db = await openSwarmKeyDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SWARM_KEY_STORE_NAME, "readonly");
      const store = tx.objectStore(SWARM_KEY_STORE_NAME);
      const request = store.get(SWARM_KEY_ENTRY);
      request.onsuccess = () => {
        const entry = request.result as SwarmSignerEntry | undefined;
        db.close();
        if (entry && entry.ownerAddress.toLowerCase() === address.toLowerCase()) {
          resolve(entry);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    });
  } catch {
    return null;
  }
}

/**
 * Save a Swarm signer to IndexedDB for future sessions.
 */
export async function cacheSwarmKey(entry: SwarmSignerEntry): Promise<void> {
  const db = await openSwarmKeyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SWARM_KEY_STORE_NAME, "readwrite");
    const store = tx.objectStore(SWARM_KEY_STORE_NAME);
    const request = store.put(entry, SWARM_KEY_ENTRY);
    request.onsuccess = () => {
      db.close();
      resolve();
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Clear the cached Swarm signer from IndexedDB.
 */
export async function clearCachedSwarmKey(): Promise<void> {
  try {
    const db = await openSwarmKeyDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SWARM_KEY_STORE_NAME, "readwrite");
      const store = tx.objectStore(SWARM_KEY_STORE_NAME);
      const request = store.delete(SWARM_KEY_ENTRY);
      request.onsuccess = () => {
        db.close();
        resolve();
      };
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    });
  } catch {
    // DB might not exist yet
  }
}

/**
 * Get or derive the Swarm signer key.
 * Checks IndexedDB cache first. If not found, requests wallet signature.
 *
 * This is the main function to call from the SwarmConnectPlugin.
 */
export async function getOrDeriveSwarmKey(
  address: string,
  origin?: string,
): Promise<SwarmSignerEntry> {
  // Check cache first
  try {
    const cached = await loadCachedSwarmKey(address);
    if (cached) {
      console.log("[SwarmSigner] Loaded key from IndexedDB cache");
      return cached;
    }
    console.log("[SwarmSigner] No cached key found, requesting wallet signature");
  } catch (err) {
    console.warn("[SwarmSigner] Cache read failed:", err);
  }

  // Not cached — need wallet signature
  const entry = await requestSwarmKeyFromWallet(address, origin);

  // Cache for future sessions
  try {
    await cacheSwarmKey(entry);
    console.log("[SwarmSigner] Key cached in IndexedDB");
  } catch (err) {
    console.warn("[SwarmSigner] Failed to cache key:", err);
  }

  return entry;
}

// ─── IndexedDB helper ───────────────────────────────────────────

function openSwarmKeyDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SWARM_KEY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SWARM_KEY_STORE_NAME)) {
        db.createObjectStore(SWARM_KEY_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function keccak256(data: Uint8Array): Uint8Array {
  return Bytes.keccak256(data).toUint8Array();
}
