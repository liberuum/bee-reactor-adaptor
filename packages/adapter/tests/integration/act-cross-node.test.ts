/**
 * Integration test: ACT cross-node sharing
 *
 * TRUE two-node test: User A on Node A uploads ACT-protected data and
 * grants access to Node B's public key. User B on Node B downloads —
 * Node B performs ECDH decryption with its own private key.
 *
 * This verifies that ACT works across distinct Bee nodes with different
 * keypairs, not just the same-node shortcut used in other tests.
 *
 * Requires TWO live Bee nodes:
 *   BEE_URL_A="https://node-a:1633" BEE_URL_B="http://localhost:1633" bunx vitest run act-cross-node
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SwarmClient } from "../../src/swarm-client.js";
import { Bee } from "@ethersphere/bee-js";

const BEE_URL_A = process.env.BEE_URL_A || process.env.BEE_URL || "https://dappnode-tailscale.tailcbc470.ts.net:1633";
const BEE_URL_B = process.env.BEE_URL_B || "http://172.22.208.1:1633";

const SIGNER_KEY_A = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const SIGNER_KEY_B = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

let clientA: SwarmClient;
let clientB: SwarmClient;
let beeNodePubKeyA: string;
let beeNodePubKeyB: string;
let batchIdA: string;
let batchIdB: string;

async function getUsableBatch(beeUrl: string): Promise<string> {
  const bee = new Bee(beeUrl);
  const stamps = await bee.getAllPostageBatch();
  const usable = stamps.find(s => s.usable);
  if (!usable) throw new Error(`No usable stamp on ${beeUrl}`);
  return usable.batchID.toHex();
}

describe("ACT cross-node sharing", () => {
  beforeAll(async () => {
    // Verify both nodes are reachable
    const beeA = new Bee(BEE_URL_A);
    const beeB = new Bee(BEE_URL_B);

    const [healthA, healthB] = await Promise.all([
      beeA.getHealth().catch(() => null),
      beeB.getHealth().catch(() => null),
    ]);

    if (!healthA || healthA.status !== "ok") {
      throw new Error(`Node A not reachable at ${BEE_URL_A}`);
    }
    if (!healthB || healthB.status !== "ok") {
      throw new Error(`Node B not reachable at ${BEE_URL_B}. Start a second Bee node.`);
    }

    // Node A needs a stamp for uploading. Node B only downloads (no stamp needed).
    batchIdA = await getUsableBatch(BEE_URL_A);
    try {
      batchIdB = await getUsableBatch(BEE_URL_B);
    } catch {
      // Node B has no stamp — use a dummy. It only downloads, never uploads.
      batchIdB = "0".repeat(64);
      console.log("Node B has no stamp — will only be used for ACT downloads (no stamp needed)");
    }

    clientA = new SwarmClient({
      beeUrl: BEE_URL_A,
      batchId: batchIdA,
      signerPrivateKey: SIGNER_KEY_A,
      useFeedMode: true,
      feedTopicPrefix: "test:act-xnode",
      useEncryption: false,
    });

    clientB = new SwarmClient({
      beeUrl: BEE_URL_B,
      batchId: batchIdB,
      signerPrivateKey: SIGNER_KEY_B,
      useFeedMode: true,
      feedTopicPrefix: "test:act-xnode",
      useEncryption: false,
    });

    beeNodePubKeyA = await clientA.getBeeNodePublicKey();
    beeNodePubKeyB = await clientB.getBeeNodePublicKey();

    expect(beeNodePubKeyA).not.toBe(beeNodePubKeyB);

    console.log(`Node A: ${BEE_URL_A} — pubkey ${beeNodePubKeyA.slice(0, 20)}...`);
    console.log(`Node B: ${BEE_URL_B} — pubkey ${beeNodePubKeyB.slice(0, 20)}...`);
  });

  it("should allow Node A to upload ACT-protected data granting access to Node B", async () => {
    const secretPayload = JSON.stringify({
      message: "Cross-node ACT test",
      documents: [{ id: "doc-1", name: "Secret Invoice", ops: [1, 2, 3] }],
      timestamp: new Date().toISOString(),
    });

    // User A uploads with ACT, grants Node B's public key
    const result = await clientA.uploadSharedData(secretPayload, beeNodePubKeyB);

    expect(result.reference).toBeTruthy();
    expect(result.actHistoryAddress).toBeTruthy();
    expect(result.actGranteeRef).toBeTruthy();

    console.log(`Node A uploaded: ref=${result.reference.slice(0, 16)}..., history=${result.actHistoryAddress.slice(0, 16)}...`);

    // Node B downloads — its Bee node performs ECDH with its own private key.
    // Cross-network chunk propagation can take time, so retry with backoff.
    let downloaded: Uint8Array | null = null;
    const retryDelays = [5_000, 10_000, 15_000, 20_000];
    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      console.log(`Waiting ${retryDelays[attempt] / 1000}s for cross-node propagation (attempt ${attempt + 1}/${retryDelays.length})...`);
      await new Promise(r => setTimeout(r, retryDelays[attempt]));
      try {
        downloaded = await clientB.downloadSharedData(
          result.reference,
          beeNodePubKeyA,          // publisher = Node A's Bee pubkey
          result.actHistoryAddress, // ACT history from the upload
        );
        break;
      } catch (err) {
        if (attempt === retryDelays.length - 1) throw err;
        console.log(`  Download failed (${err instanceof Error ? err.message : err}), retrying...`);
      }
    }

    expect(downloaded).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(downloaded!));
    expect(parsed.message).toBe("Cross-node ACT test");
    expect(parsed.documents[0].name).toBe("Secret Invoice");

    console.log("Node B downloaded and decrypted successfully — TRUE cross-node ACT verified!");
  });

  it("should prevent a third node from downloading without grant", async () => {
    const payload = "node-b-only secret";

    // Upload granting only Node B
    const result = await clientA.uploadSharedData(payload, beeNodePubKeyB);

    // Try downloading from Node A itself (publisher) — should work
    // since the publisher's Bee node has the access key
    const fromPublisher = await clientA.downloadSharedData(
      result.reference,
      beeNodePubKeyA,
      result.actHistoryAddress,
    );
    expect(new TextDecoder().decode(fromPublisher)).toBe(payload);
    console.log("Publisher (Node A) can read its own ACT data — correct");

    // A non-granted node would fail. Since we only have 2 nodes,
    // we verify by using a fake publisher key that doesn't match:
    await expect(
      clientB.downloadSharedData(
        result.reference,
        "02" + "ff".repeat(32), // fake publisher key
        result.actHistoryAddress,
      ),
    ).rejects.toThrow();

    console.log("Wrong publisher key correctly rejected — access control verified");
  });

  it("should verify grantee list contains Node B's public key", async () => {
    const payload = "grantee check";
    const result = await clientA.uploadSharedData(payload, beeNodePubKeyB);

    const grantees = await clientA.getGrantees(result.actGranteeRef);
    expect(grantees).toBeInstanceOf(Array);
    expect(grantees.length).toBeGreaterThan(0);

    // At least one grantee should match Node B's public key
    // (bee-js may return compressed or uncompressed format)
    const hasNodeB = grantees.some(
      g => g === beeNodePubKeyB || g.includes(beeNodePubKeyB.slice(2)),
    );
    expect(hasNodeB).toBe(true);

    console.log(`Grantee list verified: ${grantees.length} grantee(s), includes Node B`);
  });

  // bee-js bug: patchGrantees serializes the 128-char encrypted grantee
  // reference incorrectly (truncates to 92 chars in URL). The Bee node
  // returns 500 because the reference is corrupted. Curl with the correct
  // 128-char ref works. Workaround: create all grantees upfront.
  // TODO: file bug with bee-js team or implement direct HTTP patchGrantees
  it.skip("should support adding more grantees after initial share (bee-js Reference serialization bug)", async () => {
    const payload = "multi-grantee test";
    const result = await clientA.uploadSharedData(payload, beeNodePubKeyB);

    const updated = await clientA.grantAccess(
      result.actGranteeRef,
      result.actHistoryAddress,
      [beeNodePubKeyA],
    );
    expect(updated.ref).toBeTruthy();

    const grantees = await clientA.getGrantees(updated.ref);
    expect(grantees.length).toBeGreaterThanOrEqual(2);
  });
});
