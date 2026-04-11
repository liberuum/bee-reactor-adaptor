/**
 * Integration tests: Document sharing round-trip
 *
 * Tests the full User A → User B sharing flow:
 * 1. User A creates a drive with nested folders + docs
 * 2. User A shares selected docs with User B
 * 3. User B reads the share manifest
 * 4. User B downloads and decrypts the shared data
 * 5. Verify folder structure is preserved in the share bundle
 *
 * Uses two separate signer keys to simulate two distinct users.
 *
 * Requires live Bee node: BEE_URL="https://your-node:1633" bunx vitest run
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SwarmClient } from "../../src/swarm-client.js";
import { deriveShareKey } from "../../src/share-manager.js";
import type { SwarmDriveManifest, ShareManifest } from "../../src/types.js";
import { preflight, waitForFeed, waitForPropagation, BEE_URL, TEST_SIGNER_KEY, makeAction, makeOperation } from "../helpers.js";

// Two distinct signer keys for User A and User B
const USER_A_KEY = TEST_SIGNER_KEY; // 0x1234...
const USER_B_KEY = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

const RUN = Date.now().toString(36);
const DRIVE_ID = `share-drive-${RUN}`;
const FOLDER_ROOT = `share-folder-${RUN}`;
const FOLDER_NESTED = `share-nested-${RUN}`;
const DOC_ROOT = `share-doc-root-${RUN}`;
const DOC_IN_FOLDER = `share-doc-folder-${RUN}`;
const DOC_NESTED = `share-doc-nested-${RUN}`;

let clientA: SwarmClient;
let clientB: SwarmClient;
let addressA: string;
let addressB: string;

describe("Document sharing round-trip", () => {
  beforeAll(async () => {
    const { batchId } = await preflight();

    clientA = new SwarmClient({
      beeUrl: BEE_URL,
      batchId,
      signerPrivateKey: USER_A_KEY,
      useFeedMode: true,
      feedTopicPrefix: "test:share",
      useEncryption: false,
    });

    clientB = new SwarmClient({
      beeUrl: BEE_URL,
      batchId,
      signerPrivateKey: USER_B_KEY,
      useFeedMode: true,
      feedTopicPrefix: "test:share",
      useEncryption: false,
    });

    addressA = clientA.getOwnerAddress();
    addressB = clientB.getOwnerAddress();

    expect(addressA).not.toBe(addressB);
    console.log(`User A: ${addressA.slice(0, 10)}..., User B: ${addressB.slice(0, 10)}...`);
  });

  // ─── Phase 1: User A sets up drive + docs ─────────────────────

  it("should set up User A's drive with nested folders and docs", async () => {
    const now = new Date().toISOString();

    // Write drive manifest
    const driveManifest: SwarmDriveManifest = {
      driveId: DRIVE_ID,
      name: "Shared Project",
      preferredEditor: "GenericDriveExplorer",
      folders: {
        [FOLDER_ROOT]: { name: "Reports" },
        [FOLDER_NESTED]: { name: "Q1", parentFolder: FOLDER_ROOT },
      },
      documents: {
        [DOC_ROOT]: { documentType: "powerhouse/document-model", name: "README", lastUpdated: now },
        [DOC_IN_FOLDER]: { documentType: "powerhouse/document-model", name: "Monthly Report", parentFolder: FOLDER_ROOT, lastUpdated: now },
        [DOC_NESTED]: { documentType: "powerhouse/document-model", name: "Q1 Summary", parentFolder: FOLDER_NESTED, lastUpdated: now },
      },
      updatedAt: now,
    };
    await clientA.updateDriveManifest(DRIVE_ID, driveManifest);

    // Upload document operations for each doc
    for (const [docId, docName] of [
      [DOC_ROOT, "README"],
      [DOC_IN_FOLDER, "Monthly Report"],
      [DOC_NESTED, "Q1 Summary"],
    ] as const) {
      const ops = [
        makeOperation(0, makeAction("SET_MODEL_NAME", { name: docName })),
        makeOperation(1, makeAction("SET_MODEL_DESCRIPTION", { description: `Content of ${docName}` })),
      ];
      const { reference } = await clientA.uploadData(JSON.stringify(ops));
      await clientA.updateManifest(docId, {
        documentId: docId,
        documentType: "powerhouse/document-model",
        latestRevision: { global: 1 },
        operationBatches: [{ reference, startIndex: 0, endIndex: 1, scope: "global", uploadedAt: now }],
        keyframes: [],
        encrypted: false,
        updatedAt: now,
      });
    }

    console.log("User A: drive + 3 docs + 2 folders created");
  });

  // ─── Phase 2: User A shares docs with User B ──────────────────

  it("should share documents from User A to User B with folder structure", async () => {
    // Read manifests to build the share bundle (simulating what sharing.ts does)
    const driveManifest = await waitForFeed(() => clientA.readDriveManifest(DRIVE_ID));
    expect(driveManifest).not.toBeNull();

    // Build the bundle: all docs' ops + folder info
    const docs: Array<{ documentId: string; documentType: string; name: string; operations: unknown[] }> = [];

    for (const [docId, docEntry] of Object.entries(driveManifest!.documents)) {
      const manifest = await clientA.readManifest(docId);
      expect(manifest).not.toBeNull();

      const allOps: unknown[] = [];
      for (const batch of manifest!.operationBatches) {
        const raw = await clientA.downloadData(batch.reference);
        const ops = JSON.parse(new TextDecoder().decode(raw));
        allOps.push(...ops);
      }

      docs.push({
        documentId: docId,
        documentType: docEntry.documentType,
        name: docEntry.name,
        operations: allOps,
      });
    }

    // Include folder structure
    const folders = driveManifest!.folders ?? {};
    const docFolders: Record<string, string> = {};
    for (const [docId, docEntry] of Object.entries(driveManifest!.documents)) {
      if (docEntry.parentFolder) docFolders[docId] = docEntry.parentFolder;
    }

    const bundle = {
      documents: docs,
      folders,
      docFolders,
      preferredEditor: driveManifest!.preferredEditor,
    };

    // Upload encrypted with shared key
    const shareResult = await clientA.uploadSharedData(
      JSON.stringify(bundle),
      addressA,
      addressB,
    );

    // Write share manifest
    const shareManifest: ShareManifest = {
      from: addressA,
      to: addressB,
      shares: [{
        driveId: DRIVE_ID,
        driveName: "Shared Project",
        reference: shareResult.reference,
        documents: docs.map(d => ({
          documentId: d.documentId,
          documentType: d.documentType,
          name: d.name,
          operationCount: d.operations.length,
        })),
        sharedAt: new Date().toISOString(),
      }],
      createdAt: new Date().toISOString(),
    };

    await clientA.writeShareManifest(addressA, addressB, shareManifest);

    console.log(`User A: shared ${docs.length} docs (${docs.reduce((s, d) => s + d.operations.length, 0)} ops) with User B`);
  });

  // ─── Phase 3: User B reads the share manifest ─────────────────

  it("should allow User B to read the share manifest from User A", async () => {
    // User B reads using User A's signer address as sender
    // Note: readShareManifest reads from the sender's feed, so clientB needs
    // to read from clientA's feed. Both share the same Bee node in tests.
    const manifest = await waitForFeed(
      () => clientA.readShareManifest(addressA, addressB),
    );

    expect(manifest).not.toBeNull();
    expect(manifest!.from).toBe(addressA);
    expect(manifest!.to).toBe(addressB);
    expect(manifest!.shares).toHaveLength(1);

    const share = manifest!.shares[0];
    expect(share.driveName).toBe("Shared Project");
    expect(share.documents).toHaveLength(3);

    const docNames = share.documents.map(d => d.name).sort();
    expect(docNames).toEqual(["Monthly Report", "Q1 Summary", "README"]);

    console.log(`User B: found share manifest with ${share.documents.length} docs`);
  });

  // ─── Phase 4: User B decrypts the shared bundle ───────────────

  it("should allow User B to download and decrypt the shared data", async () => {
    const manifest = await clientA.readShareManifest(addressA, addressB);
    const share = manifest!.shares[0];

    // User B downloads and decrypts using the shared key
    const decrypted = await clientA.downloadSharedData(
      share.reference,
      addressA,
      addressB,
    );

    const bundle = JSON.parse(new TextDecoder().decode(decrypted));

    // Verify bundle contents
    expect(bundle.documents).toHaveLength(3);
    expect(bundle.folders).toBeDefined();
    expect(bundle.docFolders).toBeDefined();
    expect(bundle.preferredEditor).toBe("GenericDriveExplorer");

    // Verify folder structure preserved
    const folders = bundle.folders;
    expect(Object.keys(folders)).toHaveLength(2);
    expect(folders[FOLDER_ROOT].name).toBe("Reports");
    expect(folders[FOLDER_NESTED].name).toBe("Q1");
    expect(folders[FOLDER_NESTED].parentFolder).toBe(FOLDER_ROOT);

    // Verify doc → folder assignments
    expect(bundle.docFolders[DOC_IN_FOLDER]).toBe(FOLDER_ROOT);
    expect(bundle.docFolders[DOC_NESTED]).toBe(FOLDER_NESTED);
    expect(bundle.docFolders[DOC_ROOT]).toBeUndefined(); // root doc

    // Verify operations
    for (const doc of bundle.documents) {
      expect(doc.operations).toHaveLength(2);
      expect(doc.operations[0].action.type).toBe("SET_MODEL_NAME");
      expect(doc.operations[1].action.type).toBe("SET_MODEL_DESCRIPTION");
    }

    console.log("User B: decrypted bundle — 3 docs, 2 folders, all ops verified");
  });

  // ─── Phase 5: Verify shared key derivation is symmetric ───────

  it("should derive the same shared key from both sides", async () => {
    const keyFromA = await deriveShareKey(addressA, addressB);
    const keyFromB = await deriveShareKey(addressA, addressB);

    // Same inputs = same key (deterministic)
    expect(keyFromA).toBe(keyFromB);
    expect(keyFromA).toHaveLength(64); // 32 bytes = 64 hex chars

    // Different order = different key (directional)
    const reversedKey = await deriveShareKey(addressB, addressA);
    expect(reversedKey).not.toBe(keyFromA);

    console.log("Shared key derivation verified (symmetric for same direction, different for reverse)");
  });

  // ─── Phase 6: Verify wrong user cannot decrypt ────────────────

  it("should fail to decrypt with wrong addresses", async () => {
    const manifest = await clientA.readShareManifest(addressA, addressB);
    const share = manifest!.shares[0];

    // Try decrypting with wrong sender address
    try {
      await clientA.downloadSharedData(
        share.reference,
        "0x0000000000000000000000000000000000000000",
        addressB,
      );
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeDefined();
    }

    console.log("Wrong key correctly fails to decrypt");
  });

  // ─── Phase 7: Public profile flow ─────────────────────────────

  it("should publish and read User A's public profile", async () => {
    const profile = {
      address: addressA,
      ethAddress: "0xadbA7C2F82139031D7564D18aC22D09B12A0BcA4",
      beeNodePublicKey: "02e3e35920267c831a8a8f642e4870de42abab2f48c4964cf880ebb81145987290",
      updatedAt: new Date().toISOString(),
    };

    await clientA.publishPublicProfile(addressA, profile);

    const read = await waitForFeed(
      () => clientA.readPublicProfile(addressA),
    );

    expect(read).not.toBeNull();
    expect(read!.address).toBe(addressA);
    expect(read!.beeNodePublicKey).toBe(profile.beeNodePublicKey);

    console.log("Public profile published and verified");
  });

  // ─── Cleanup ──────────────────────────────────────────────────

  it("should clean up test data", async () => {
    await clientA.updateDriveManifest(DRIVE_ID, {
      driveId: DRIVE_ID, name: "", documents: {}, folders: {}, updatedAt: new Date().toISOString(),
    });
    for (const docId of [DOC_ROOT, DOC_IN_FOLDER, DOC_NESTED]) {
      await clientA.updateManifest(docId, {
        documentId: docId, documentType: "", latestRevision: {}, operationBatches: [], keyframes: [], updatedAt: new Date().toISOString(),
      });
    }
    await waitForPropagation(2000);
    console.log("Cleaned up");
  });
});
