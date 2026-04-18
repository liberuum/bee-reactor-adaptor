/**
 * Integration test: CollabManifestFeed cross-node round trip.
 *
 * Exercises the mutable participant manifest used by the Collaborate
 * tab's Manage panel + boot-time rehydrate:
 *
 *   1. Initiator publishes revision 0 (full grantee list).
 *   2. Each participant can read + ACT-decrypt the latest revision.
 *   3. Initiator publishes revision 1 under a NEW grantee chain that
 *      omits one peer (simulating a revoke). The kept peer still reads;
 *      the revoked peer cannot decrypt the new revision (ACT rejects).
 *   4. Previous revisions remain readable by their original grantees
 *      — ACT has no rewind; revoke only blocks the future.
 *
 * Two Bee nodes required (same defaults as other integration tests).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Bee } from "@ethersphere/bee-js";
import { SwarmClient } from "../../src/swarm-client.js";
import { CollabManifestFeed } from "../../src/collab/collab-manifest-feed.js";
import type { CollabManifest } from "../../src/collab/types.js";
import { buildCollabId } from "../../src/collab/types.js";

const BEE_URL_A = process.env.BEE_URL_A || process.env.BEE_URL || "https://dappnode-tailscale.tailcbc470.ts.net:1633";
const BEE_URL_B = process.env.BEE_URL_B || "http://172.22.208.1:1633";

const SIGNER_KEY_A = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const SIGNER_KEY_B = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

async function usableBatch(url: string): Promise<string | null> {
  const bee = new Bee(url);
  const stamps = await bee.getAllPostageBatch();
  return stamps.find((s) => s.usable)?.batchID.toHex() ?? null;
}

describe("CollabManifestFeed: cross-node ACT round trip", () => {
  let clientA: SwarmClient;
  let clientB: SwarmClient;
  let beePubA: string;
  let beePubB: string;
  let addressA: string;

  beforeAll(async () => {
    const beeA = new Bee(BEE_URL_A);
    const beeB = new Bee(BEE_URL_B);
    const [healthA, healthB] = await Promise.all([
      beeA.getHealth().catch(() => null),
      beeB.getHealth().catch(() => null),
    ]);
    if (healthA?.status !== "ok") throw new Error(`Node A unreachable at ${BEE_URL_A}`);
    if (healthB?.status !== "ok") throw new Error(`Node B unreachable at ${BEE_URL_B}`);

    const batchA = await usableBatch(BEE_URL_A);
    if (!batchA) throw new Error(`No usable stamp on Node A`);
    const batchB = (await usableBatch(BEE_URL_B)) ?? "0".repeat(64);

    const runPrefix = `test:collabmanifest:${Date.now()}`;

    clientA = new SwarmClient({
      beeUrl: BEE_URL_A,
      batchId: batchA,
      signerPrivateKey: SIGNER_KEY_A,
      useFeedMode: true,
      feedTopicPrefix: runPrefix,
      useEncryption: false,
    });
    clientB = new SwarmClient({
      beeUrl: BEE_URL_B,
      batchId: batchB,
      signerPrivateKey: SIGNER_KEY_B,
      useFeedMode: true,
      feedTopicPrefix: runPrefix,
      useEncryption: false,
    });

    beePubA = await clientA.getBeeNodePublicKey();
    beePubB = await clientB.getBeeNodePublicKey();
    addressA = clientA.getOwnerAddress();

    console.log(`Node A: ${BEE_URL_A}`);
    console.log(`Node B: ${BEE_URL_B}`);
  });

  it("initiator publishes manifest → participant reads + decrypts", async () => {
    const driveId = `drive-${Date.now().toString(16)}`;
    const collabId = buildCollabId("drive", driveId);

    const manifestFeedA = new CollabManifestFeed(clientA);
    const manifestFeedB = new CollabManifestFeed(clientB);

    // Initiator creates a grantee chain covering both parties.
    const { historyRef: histRef } = await clientA.createGrantees([beePubA, beePubB]);
    await new Promise((r) => setTimeout(r, 1100)); // ACT 1s rule

    const manifest: CollabManifest = {
      version: 1,
      collabId,
      kind: "drive",
      driveId,
      title: "Manifest test drive",
      initiator: addressA.toLowerCase(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      participants: [
        {
          address: addressA.toLowerCase(),
          beeNodePublicKey: beePubA,
          joinedAt: new Date().toISOString(),
        },
        {
          address: clientB.getOwnerAddress().toLowerCase(),
          beeNodePublicKey: beePubB,
          joinedAt: new Date().toISOString(),
          displayName: "Peer B",
        },
      ],
      caption: "Test collab",
    };

    const { feedIndex, actRef, actHistoryAddress } = await manifestFeedA.publish(manifest, histRef);
    expect(feedIndex).toBeGreaterThanOrEqual(0);
    expect(actRef).toMatch(/^[0-9a-f]+$/);
    expect(actHistoryAddress).toMatch(/^[0-9a-f]+$/);

    // Node B reads + decrypts. Poll with retry for cross-node propagation.
    let read: { manifest: CollabManifest; feedIndex: number } | null = null;
    for (const wait of [4_000, 7_000, 12_000, 18_000]) {
      await new Promise((r) => setTimeout(r, wait));
      try {
        read = await manifestFeedB.readLatest(collabId, addressA, beePubA);
        if (read) break;
      } catch {
        /* retry */
      }
    }

    expect(read).not.toBeNull();
    expect(read!.manifest.collabId).toBe(collabId);
    expect(read!.manifest.title).toBe("Manifest test drive");
    expect(read!.manifest.participants).toHaveLength(2);
    expect(read!.manifest.participants[1].displayName).toBe("Peer B");
    expect(read!.feedIndex).toBe(feedIndex);
    console.log(`Node B read manifest index ${read!.feedIndex} with ${read!.manifest.participants.length} participants`);
  }, 60_000);

  it("revoke flow: initiator publishes revision 1 under a chain that excludes peer → peer cannot read the NEW revision", async () => {
    const driveId = `revdrive-${Date.now().toString(16)}`;
    const collabId = buildCollabId("drive", driveId);

    const manifestFeedA = new CollabManifestFeed(clientA);
    const manifestFeedB = new CollabManifestFeed(clientB);

    // Revision 0: both parties granted.
    const { historyRef: hist0 } = await clientA.createGrantees([beePubA, beePubB]);
    await new Promise((r) => setTimeout(r, 1100));

    const now = new Date().toISOString();
    const manifestV0: CollabManifest = {
      version: 1,
      collabId,
      kind: "drive",
      driveId,
      title: "Revoke scenario",
      initiator: addressA.toLowerCase(),
      createdAt: now,
      updatedAt: now,
      participants: [
        { address: addressA.toLowerCase(), beeNodePublicKey: beePubA, joinedAt: now },
        { address: clientB.getOwnerAddress().toLowerCase(), beeNodePublicKey: beePubB, joinedAt: now },
      ],
    };
    const v0 = await manifestFeedA.publish(manifestV0, hist0);
    await new Promise((r) => setTimeout(r, 1100));

    // Revision 1: NEW grantee chain with only initiator — simulates a
    // full revoke of peer B. (In production this is what
    // CollabManager.revokeParticipant would pass.)
    const { historyRef: hist1 } = await clientA.createGrantees([beePubA]);
    await new Promise((r) => setTimeout(r, 1100));

    const later = new Date(Date.now() + 1000).toISOString();
    const manifestV1: CollabManifest = {
      ...manifestV0,
      participants: [
        { address: addressA.toLowerCase(), beeNodePublicKey: beePubA, joinedAt: now },
      ],
      updatedAt: later,
    };
    const v1 = await manifestFeedA.publish(manifestV1, hist1);
    expect(v1.feedIndex).toBeGreaterThan(v0.feedIndex);

    // Give propagation time.
    await new Promise((r) => setTimeout(r, 8_000));

    // Peer B's node can still read the LATEST revision's feed entry
    // (feed itself is public) but ACT decryption fails because the new
    // chain excludes their pubkey. readLatest returns null (it catches
    // the decrypt failure).
    const attempt = await manifestFeedB.readLatest(collabId, addressA, beePubA);
    if (attempt !== null) {
      // Cross-node timing can leave the latest index still pointing at
      // the old entry; accept either outcome, but if it returns v0 we
      // assert the participant list matches v0 (2 participants).
      console.log(`Latest index visible to B: ${attempt.feedIndex}, participants: ${attempt.manifest.participants.length}`);
      expect(attempt.feedIndex).toBe(v0.feedIndex);
      expect(attempt.manifest.participants).toHaveLength(2);
    } else {
      console.log(`Peer B correctly denied access to revision ${v1.feedIndex}`);
    }

    // Initiator reads the latest revision via readLatest. When Bee's
    // first "latest" lookup returns a stale index, readLatest now
    // self-corrects via feedIndexNext and re-fetches at the real head.
    const asInitiator = await manifestFeedA.readLatest(collabId, addressA, beePubA);
    expect(asInitiator).not.toBeNull();
    expect(asInitiator!.feedIndex).toBe(v1.feedIndex);
    expect(asInitiator!.manifest.participants).toHaveLength(1);
    console.log(`Initiator reads revision ${asInitiator!.feedIndex} with ${asInitiator!.manifest.participants.length} participant(s) — revoke confirmed`);

    // ACT has no rewind: peer B can still read the OLD revision at its
    // original feed index using the OLD actPublisher context. This is
    // the key invariant of the "revoke only affects the future" model.
    const oldRevision = await manifestFeedB.readAtIndex(collabId, addressA, beePubA, v0.feedIndex);
    expect(oldRevision).not.toBeNull();
    expect(oldRevision!.participants).toHaveLength(2);
    console.log(`Revoked peer B still reads the PRE-revoke revision at index ${v0.feedIndex} — ACT non-rewind invariant holds`);
  }, 90_000);

  it("readLatest returns null for a nonexistent feed (graceful missing-manifest)", async () => {
    const manifestFeedB = new CollabManifestFeed(clientB);
    const result = await manifestFeedB.readLatest(
      "drive:does-not-exist",
      addressA,
      beePubA,
    );
    expect(result).toBeNull();
  });
});
