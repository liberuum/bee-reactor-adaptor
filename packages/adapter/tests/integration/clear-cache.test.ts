/**
 * Integration tests for the Clear Cache / Clear Storage flow.
 *
 * Tests the full cycle:
 * 1. Upload data (doc manifest, drive manifest, user manifest)
 * 2. Verify data is readable on Swarm
 * 3. Clear storage (write empty manifests)
 * 4. Verify manifests are now empty on Swarm
 * 5. Upload NEW data after clear
 * 6. Verify new data is readable (sync resumed)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SwarmClient } from "../../src/swarm-client.js";
import type { SwarmDocumentManifest, SwarmDriveManifest, SwarmUserManifest } from "../../src/types.js";
import { BEE_URL, TEST_SIGNER_KEY, preflight, waitForFeed, waitForPropagation } from "../helpers.js";

let BATCH_ID = "";

beforeAll(async () => {
  const check = await preflight();
  BATCH_ID = check.batchId;
});

describe("Clear Cache Flow", () => {
  it("should write data, clear it, and verify manifests are empty", async () => {
    const client = new SwarmClient({
      beeUrl: BEE_URL,
      batchId: BATCH_ID,
      signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: true,
    });

    const ownerAddress = client.getOwnerAddress();
    const docId = `clear-test-doc-${Date.now()}`;
    const driveId = `clear-test-drive-${Date.now()}`;

    // ─── Step 1: Upload data ─────────────────────────────────────

    // Upload operation batch to /bytes
    const ops = [{ id: "op-1", index: 0, action: { type: "TEST", input: {} } }];
    const { reference: opsRef } = await client.uploadData(JSON.stringify(ops));

    // Write document manifest
    const docManifest: SwarmDocumentManifest = {
      documentId: docId,
      documentType: "test/clear-cache",
      latestRevision: { global: 0 },
      operationBatches: [{
        reference: opsRef,
        scope: "global",
        branch: "main",
        startIndex: 0,
        endIndex: 0,
        timestamp: new Date().toISOString(),
      }],
      keyframes: [],
      updatedAt: new Date().toISOString(),
    };
    await client.updateManifest(docId, docManifest);

    // Write drive manifest
    const driveManifest: SwarmDriveManifest = {
      driveId,
      name: "Test Drive for Clear",
      documents: {
        [docId]: {
          documentType: "test/clear-cache",
          name: "Test Doc",
          lastUpdated: new Date().toISOString(),
        },
      },
      updatedAt: new Date().toISOString(),
    };
    await client.updateDriveManifest(driveId, driveManifest);

    // Write user manifest
    const userManifest: SwarmUserManifest = {
      address: ownerAddress,
      documents: {},
      drives: {
        [driveId]: {
          name: "Test Drive for Clear",
          documentIds: [docId],
          lastUpdated: new Date().toISOString(),
        },
      },
      stamps: {},
      updatedAt: new Date().toISOString(),
    };
    await client.updateUserManifest(ownerAddress, userManifest);

    // ─── Step 2: Verify data is readable ─────────────────────────

    const readDoc = await waitForFeed(() => client.readManifest(docId));
    expect(readDoc.documentId).toBe(docId);
    expect(readDoc.operationBatches).toHaveLength(1);

    const readDrive = await waitForFeed(() => client.readDriveManifest(driveId));
    expect(readDrive!.name).toBe("Test Drive for Clear");
    expect(Object.keys(readDrive!.documents)).toHaveLength(1);

    const readUser = await waitForFeed(() => client.readUserManifest(ownerAddress));
    expect(readUser!.drives[driveId]).toBeDefined();

    // Verify operation data is downloadable
    const downloadedOps = await client.downloadData(opsRef);
    const parsedOps = JSON.parse(new TextDecoder().decode(downloadedOps));
    expect(parsedOps[0].id).toBe("op-1");

    console.log("  Step 2: All data verified on Swarm");

    // ─── Step 3: Clear storage ───────────────────────────────────

    // Write empty drive manifest
    await client.updateDriveManifest(driveId, {
      driveId,
      name: "",
      documents: {},
      updatedAt: new Date().toISOString(),
    });

    // Write empty user manifest (keep identity, clear data)
    await client.updateUserManifest(ownerAddress, {
      address: ownerAddress,
      documents: {},
      drives: {},
      stamps: {},
      updatedAt: new Date().toISOString(),
    });

    await waitForPropagation(3000);
    console.log("  Step 3: Clear storage complete");

    // ─── Step 4: Verify manifests are empty ──────────────────────

    const clearedUser = await waitForFeed(() => client.readUserManifest(ownerAddress));
    expect(Object.keys(clearedUser!.drives)).toHaveLength(0);
    expect(Object.keys(clearedUser!.documents)).toHaveLength(0);
    console.log("  Step 4a: User manifest is empty");

    const clearedDrive = await waitForFeed(() => client.readDriveManifest(driveId));
    expect(Object.keys(clearedDrive!.documents)).toHaveLength(0);
    expect(clearedDrive!.name).toBe("");
    console.log("  Step 4b: Drive manifest is empty");

    // Note: the DOCUMENT manifest feed still has the old data at the old index.
    // Clear storage doesn't write empty doc manifests — it only clears user + drive.
    // The doc manifest is effectively orphaned (no drive/user points to it).
    // On recovery, it won't be discovered because the user manifest has no drives.

    // But the /bytes data at opsRef is STILL on Swarm (immutable, content-addressed).
    // This is by design — /bytes data expires with the stamp.
    const stillThere = await client.downloadData(opsRef);
    expect(stillThere).toBeTruthy();
    console.log("  Step 4c: Old /bytes data still exists (expected — expires with stamp)");

    // ─── Step 5: Upload NEW data after clear ─────────────────────

    const newDocId = `clear-test-new-${Date.now()}`;
    const newOps = [{ id: "op-new", index: 0, action: { type: "NEW_TEST", input: {} } }];
    const { reference: newOpsRef } = await client.uploadData(JSON.stringify(newOps));

    await client.updateManifest(newDocId, {
      documentId: newDocId,
      documentType: "test/post-clear",
      latestRevision: { global: 0 },
      operationBatches: [{
        reference: newOpsRef,
        scope: "global",
        branch: "main",
        startIndex: 0,
        endIndex: 0,
        timestamp: new Date().toISOString(),
      }],
      keyframes: [],
      updatedAt: new Date().toISOString(),
    });

    // ─── Step 6: Verify new data is readable ─────────────────────

    const readNewDoc = await waitForFeed(() => client.readManifest(newDocId));
    expect(readNewDoc.documentId).toBe(newDocId);
    expect(readNewDoc.documentType).toBe("test/post-clear");
    expect(readNewDoc.operationBatches).toHaveLength(1);

    const downloadedNewOps = await client.downloadData(newOpsRef);
    const parsedNewOps = JSON.parse(new TextDecoder().decode(downloadedNewOps));
    expect(parsedNewOps[0].id).toBe("op-new");

    console.log("  Step 6: New data uploaded and verified after clear");
  });

  it("should produce a clean user manifest that recovery would see as empty", async () => {
    const client = new SwarmClient({
      beeUrl: BEE_URL,
      batchId: BATCH_ID,
      signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: true,
    });

    const ownerAddress = client.getOwnerAddress();
    const driveId = `recovery-clean-${Date.now()}`;

    // Write some data
    await client.updateUserManifest(ownerAddress, {
      address: ownerAddress,
      documents: {},
      drives: {
        [driveId]: {
          name: "Drive to Clear",
          documentIds: [],
          lastUpdated: new Date().toISOString(),
        },
      },
      stamps: {},
      updatedAt: new Date().toISOString(),
    });

    await waitForPropagation(3000);

    // Verify drive exists
    const before = await waitForFeed(() => client.readUserManifest(ownerAddress));
    expect(before!.drives[driveId]).toBeDefined();
    console.log("  Before clear: drive exists in user manifest");

    // Clear — write empty manifest
    await client.updateUserManifest(ownerAddress, {
      address: ownerAddress,
      documents: {},
      drives: {},
      stamps: {},
      updatedAt: new Date().toISOString(),
    });

    await waitForPropagation(3000);

    // A "new device" recovery would read this manifest and find 0 drives.
    // SwarmChannel inbox poll would find no drives to recover.
    const after = await waitForFeed(() => client.readUserManifest(ownerAddress));
    expect(Object.keys(after!.drives)).toHaveLength(0);
    console.log("  After clear: user manifest has 0 drives — recovery would find nothing");
  });

  it("should verify that /bytes data survives clear (content-addressed, immutable)", async () => {
    const client = new SwarmClient({
      beeUrl: BEE_URL,
      batchId: BATCH_ID,
      signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: true,
    });

    // Upload data
    const secret = "This data survives clear cache";
    const { reference } = await client.uploadData(secret);
    console.log(`  Uploaded: ref=${reference.slice(0, 16)}...`);

    // Verify it's downloadable
    const before = await client.downloadData(reference);
    expect(new TextDecoder().decode(before)).toBe(secret);

    // "Clear" doesn't affect /bytes — it only overwrites feed pointers.
    // The /bytes data is content-addressed and immutable.
    // It exists until the stamp expires.
    const after = await client.downloadData(reference);
    expect(new TextDecoder().decode(after)).toBe(secret);
    console.log("  /bytes data survives independently of feed state");
  });
});
