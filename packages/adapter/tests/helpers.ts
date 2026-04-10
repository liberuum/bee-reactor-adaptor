/**
 * Shared test helpers and realistic fixtures based on actual
 * exported Connect document model data.
 */
import type { SwarmClient } from "../src/swarm-client.js";
import type { Operation, Action } from "../src/swarm-operation-store.js";

import { Bee } from "@ethersphere/bee-js";

// ─── Bee Node Configuration ─────────────────────────────────────

export const BEE_URL = process.env.BEE_URL || "http://localhost:1633";
export const TEST_SIGNER_KEY = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

// ─── Pre-flight Health Check ────────────────────────────────────

/**
 * Validate the Bee node and stamp before running tests.
 * Returns the usable batch ID or throws with a clear diagnostic message.
 */
export async function preflight(): Promise<{ batchId: string; health: string }> {
  const bee = new Bee(BEE_URL);

  // 1. Node health
  let health: { status: string };
  try {
    health = await bee.getHealth();
  } catch (err) {
    throw new Error(`Bee node not reachable at ${BEE_URL}. Is it running?\n${err}`);
  }
  if (health.status !== "ok") {
    throw new Error(`Bee node health is "${health.status}" — expected "ok"`);
  }

  // 2. Find a usable stamp
  const stamps = await bee.getAllPostageBatch();
  if (stamps.length === 0) {
    throw new Error("No postage stamps found on the Bee node. Create one first.");
  }

  const usable = stamps.find(s => s.usable);
  if (!usable) {
    throw new Error(`Found ${stamps.length} stamp(s) but none are usable (all expired or not yet synced).`);
  }

  const batchId = usable.batchID.toHex();
  const ttl = usable.duration.toSeconds();
  const capacityBytes = usable.size.toBytes();
  const remainingBytes = usable.remainingSize.toBytes();
  const usage = Math.round(usable.usage * 100);

  // 3. Check stamp has enough TTL
  if (ttl < 3600) {
    console.warn(`WARNING: Stamp ${batchId.slice(0, 12)}... has less than 1 hour remaining (${ttl}s). Tests may fail if stamp expires mid-run.`);
  }

  // 4. Check stamp has enough capacity
  if (remainingBytes < 1_000_000) {
    console.warn(`WARNING: Stamp ${batchId.slice(0, 12)}... has less than 1 MB remaining (${remainingBytes} bytes, ${usage}% used). Tests may fail if stamp fills up.`);
  }

  const capacityMB = Math.round(capacityBytes / 1_000_000);
  const remainingMB = Math.round(remainingBytes / 1_000_000);
  const ttlHuman = ttl > 86400 ? `${Math.floor(ttl / 86400)}d` : ttl > 3600 ? `${Math.floor(ttl / 3600)}h` : `${Math.floor(ttl / 60)}m`;

  console.log(`Bee node: ${BEE_URL} — ${health.status}`);
  console.log(`Stamp: ${batchId.slice(0, 12)}... — ${usage}% used, ${remainingMB}/${capacityMB} MB free, TTL ${ttlHuman}`);

  return { batchId, health: health.status };
}

// ─── Realistic Action Factory ───────────────────────────────────
// Based on actual exported Connect document model structure:
// /home/p/Powerhouse/swarm-connect/exported profile doc model/

let actionCounter = 0;

export function makeAction(
  type: string,
  input: unknown,
  scope = "global",
  signerAddress?: string,
): Action {
  actionCounter++;
  const ts = new Date().toISOString();
  return {
    id: `${crypto.randomUUID()}`,
    type,
    timestampUtcMs: ts,
    input,
    scope,
    attachments: undefined,
    context: signerAddress ? {
      signer: {
        user: { address: signerAddress, networkId: "eip155" },
        app: { name: "connect", key: "did:key:zTestKey..." },
      },
    } : undefined,
  };
}

export function makeOperation(index: number, action?: Action): Operation {
  const act = action ?? makeAction("UPDATE_PROFILE", { name: `Test ${index}` });
  return {
    id: `${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`,
    index,
    skip: 0,
    timestampUtcMs: new Date().toISOString(),
    hash: `${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("base64")}`,
    action: act,
  };
}

// ─── Realistic Document Model Fixture ───────────────────────────

export const SAMPLE_HEADER = {
  id: "db9905ae-bdc9-4f7f-bdf2-37e7b014f72f",
  name: "my profile",
  slug: "db9905ae-bdc9-4f7f-bdf2-37e7b014f72f",
  branch: "main",
  documentType: "powerhouse/builder-profile",
  revision: { global: 14 },
  createdAtUtcIso: "2026-04-09T11:52:39.732Z",
  lastModifiedAtUtcIso: "2026-04-09T13:30:07.706Z",
};

export const SAMPLE_STATE = {
  global: {
    id: "db9905ae-bdc9-4f7f-bdf2-37e7b014f72f",
    code: "asd",
    name: "asda",
    slug: "asdadasdasd",
    about: "asdad",
    description: "asdadas",
  },
  local: {},
};

// ─── Feed Propagation Wait ──────────────────────────────────────

/**
 * Wait for a feed to become readable after a write.
 *
 * Live Bee nodes need time for SOC propagation to the neighborhood.
 * This function polls until the feed returns data or times out.
 *
 * @param fn — async function that reads from the feed, returns null if not ready
 * @param maxWaitMs — total time to wait before giving up (default 15s)
 * @param intervalMs — polling interval (default 2s)
 */
export async function waitForFeed<T>(
  fn: () => Promise<T | null>,
  maxWaitMs = 30_000,
  intervalMs = 3_000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const result = await fn();
      if (result !== null) return result;
    } catch {
      // Feed not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Feed did not become readable within ${maxWaitMs}ms`);
}

/**
 * Wait for an async Swarm upload to propagate.
 * Use after fire-and-forget operations (SwarmOperationStore.apply, keyframe writes).
 */
export async function waitForPropagation(ms = 3000): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
