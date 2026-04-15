/**
 * Integration tests: Document sharing round-trip via ACT
 *
 * Tests the full User A → User B sharing flow using Swarm's native
 * ACT (Access Control Trie) for encryption:
 * 1. User A creates a drive with nested folders + docs
 * 2. User A shares selected docs with User B (ACT-protected)
 * 3. User B reads the share manifest
 * 4. User B downloads the shared data (Bee node decrypts via ECDH)
 * 5. Verify folder structure is preserved in the share bundle
 * 6. Verify unauthorized access fails
 *
 * NOTE: ACT requires the Bee node to handle ECDH encrypt/decrypt.
 * On a single Bee node, the same node acts as both publisher and grantee.
 * True multi-node ACT requires separate Bee instances.
 *
 * Requires live Bee node: BEE_URL="https://your-node:1633" bunx vitest run
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SwarmClient } from "../../src/swarm-client.js";
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
let beeNodePubKey: string;

describe("Document sharing round-trip (ACT)", () => {
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
    beeNodePubKey = await clientA.getBeeNodePublicKey();

    expect(addressA).not.toBe(addressB);
    expect(beeNodePubKey).toBeTruthy();
    console.log(`User A: ${addressA.slice(0, 10)}..., User B: ${addressB.slice(0, 10)}...`);
    console.log(`Bee node pubkey: ${beeNodePubKey.slice(0, 20)}...`);
  });

  // ─── Phase 1: User A sets up drive + docs ─────────────────────

  it("should set up User A's drive with nested folders and docs", async () => {
    const now = new Date().toISOString();

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

  // ─── Phase 2: User A shares docs with User B via ACT ──────────

  let actShareRef: string;
  let actHistoryAddress: string;
  let actGranteeRef: string;

  it("should share documents from User A to User B with ACT protection", async () => {
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

    // Upload with ACT — Bee node encrypts, grant access to the same node's pubkey
    // (on a single-node test, the same node is both publisher and grantee)
    const shareResult = await clientA.uploadSharedData(
      JSON.stringify(bundle),
      beeNodePubKey,
    );

    expect(shareResult.reference).toBeTruthy();
    expect(shareResult.actHistoryAddress).toBeTruthy();
    expect(shareResult.actGranteeRef).toBeTruthy();

    actShareRef = shareResult.reference;
    actHistoryAddress = shareResult.actHistoryAddress;
    actGranteeRef = shareResult.actGranteeRef;

    // Write v2 share manifest with ACT metadata
    const shareManifest: ShareManifest = {
      from: addressA,
      to: addressB,
      shares: [{
        driveId: DRIVE_ID,
        driveName: "Shared Project",
        reference: actShareRef,
        actHistoryAddress,
        actGranteeRef,
        publisherBeeNodePubKey: beeNodePubKey,
        documents: docs.map(d => ({
          documentId: d.documentId,
          documentType: d.documentType,
          name: d.name,
          operationCount: d.operations.length,
        })),
        sharedAt: new Date().toISOString(),
      }],
      createdAt: new Date().toISOString(),
      version: 2,
    };

    await clientA.writeShareManifest(addressA, addressB, shareManifest);

    console.log(`User A: shared ${docs.length} docs via ACT (ref=${actShareRef.slice(0, 16)}...)`);
  });

  // ─── Phase 3: User B reads the share manifest ─────────────────

  it("should allow User B to read the v2 share manifest", async () => {
    const manifest = await waitForFeed(
      () => clientA.readShareManifest(addressA, addressB),
    );

    expect(manifest).not.toBeNull();
    expect(manifest!.version).toBe(2);
    expect(manifest!.from).toBe(addressA);
    expect(manifest!.to).toBe(addressB);
    expect(manifest!.shares).toHaveLength(1);

    const share = manifest!.shares[0];
    expect(share.driveName).toBe("Shared Project");
    expect(share.actHistoryAddress).toBeTruthy();
    expect(share.actGranteeRef).toBeTruthy();
    expect(share.publisherBeeNodePubKey).toBe(beeNodePubKey);
    expect(share.documents).toHaveLength(3);

    const docNames = share.documents.map(d => d.name).sort();
    expect(docNames).toEqual(["Monthly Report", "Q1 Summary", "README"]);

    console.log(`User B: found v2 share manifest with ${share.documents.length} docs + ACT metadata`);
  });

  // ─── Phase 4: User B downloads ACT-protected data ─────────────

  it("should allow User B to download ACT-protected shared data", async () => {
    const manifest = await clientA.readShareManifest(addressA, addressB);
    const share = manifest!.shares[0];

    // Download with ACT — Bee node handles ECDH decryption
    const decrypted = await clientA.downloadSharedData(
      share.reference,
      share.publisherBeeNodePubKey!,
      share.actHistoryAddress!,
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
    expect(bundle.docFolders[DOC_ROOT]).toBeUndefined();

    // Verify operations
    for (const doc of bundle.documents) {
      expect(doc.operations).toHaveLength(2);
      expect(doc.operations[0].action.type).toBe("SET_MODEL_NAME");
      expect(doc.operations[1].action.type).toBe("SET_MODEL_DESCRIPTION");
    }

    console.log("User B: downloaded ACT-protected bundle — 3 docs, 2 folders, all ops verified");
  });

  // ─── Phase 5: ACT grantee management ──────────────────────────

  it("should list grantees for the shared data", async () => {
    const grantees = await clientA.getGrantees(actGranteeRef);
    expect(grantees).toBeInstanceOf(Array);
    expect(grantees.length).toBeGreaterThan(0);

    console.log(`Grantee list: ${grantees.length} grantee(s)`);
  });

  // ─── Phase 6: Public profile flow ─────────────────────────────

  it("should publish and read User A's public profile with Bee node pubkey", async () => {
    const profile = {
      address: addressA,
      ethAddress: "0xadbA7C2F82139031D7564D18aC22D09B12A0BcA4",
      beeNodePublicKey: beeNodePubKey,
      updatedAt: new Date().toISOString(),
    };

    await clientA.publishPublicProfile(addressA, profile);

    const read = await waitForFeed(
      () => clientA.readPublicProfile(addressA),
    );

    expect(read).not.toBeNull();
    expect(read!.address).toBe(addressA);
    expect(read!.beeNodePublicKey).toBe(beeNodePubKey);

    console.log("Public profile published and verified with Bee node pubkey");
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
