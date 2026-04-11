/**
 * Integration tests: Drive + Folder + Document topology
 *
 * Tests the full flow of creating a drive with nested folders and documents,
 * writing the drive manifest to Swarm, reading it back, and verifying the
 * complete folder tree is preserved.
 *
 * Structure under test:
 *
 *   my drive/
 *     ├── root-doc (document at drive root)
 *     ├── first folder/
 *     │   ├── doc-in-first (document)
 *     │   └── nested folder/
 *     │       └── deep-doc (document)
 *     └── second folder/
 *         └── another-doc (document)
 *
 * Requires a live Bee node: BEE_URL="https://your-node:1633" bunx vitest run tests/integration/drive-folders.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SwarmClient } from "../../src/swarm-client.js";
import type { SwarmDriveManifest, SwarmUserManifest } from "../../src/types.js";
import { preflight, waitForFeed, waitForPropagation, BEE_URL, TEST_SIGNER_KEY, makeAction, makeOperation } from "../helpers.js";

// ─── Test IDs (deterministic for reproducibility) ──────────────

const DRIVE_ID = `drive-test-${Date.now().toString(36)}`;
const FOLDER_FIRST = `folder-first-${Date.now().toString(36)}`;
const FOLDER_NESTED = `folder-nested-${Date.now().toString(36)}`;
const FOLDER_SECOND = `folder-second-${Date.now().toString(36)}`;
const DOC_ROOT = `doc-root-${Date.now().toString(36)}`;
const DOC_IN_FIRST = `doc-in-first-${Date.now().toString(36)}`;
const DOC_DEEP = `doc-deep-${Date.now().toString(36)}`;
const DOC_IN_SECOND = `doc-in-second-${Date.now().toString(36)}`;

let client: SwarmClient;
let ownerAddress: string;

describe("Drive + Folder + Document topology", () => {
  beforeAll(async () => {
    const { batchId } = await preflight();
    client = new SwarmClient({
      beeUrl: BEE_URL,
      batchId,
      signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: true,
      feedTopicPrefix: "test:folders",
      useEncryption: false, // plaintext for test readability
    });
    ownerAddress = client.getOwnerAddress();
    console.log(`Owner: ${ownerAddress}, Drive: ${DRIVE_ID}`);
  });

  // ─── 1. Write a drive manifest with nested folders ────────────

  it("should write a drive manifest with 3 folders and 4 documents", async () => {
    const manifest: SwarmDriveManifest = {
      driveId: DRIVE_ID,
      name: "my drive",
      preferredEditor: "GenericDriveExplorer",
      documents: {
        [DOC_ROOT]: {
          documentType: "powerhouse/document-model",
          name: "root-doc",
          parentFolder: undefined,
          lastUpdated: new Date().toISOString(),
        },
        [DOC_IN_FIRST]: {
          documentType: "powerhouse/document-model",
          name: "doc-in-first",
          parentFolder: FOLDER_FIRST,
          lastUpdated: new Date().toISOString(),
        },
        [DOC_DEEP]: {
          documentType: "powerhouse/document-model",
          name: "deep-doc",
          parentFolder: FOLDER_NESTED,
          lastUpdated: new Date().toISOString(),
        },
        [DOC_IN_SECOND]: {
          documentType: "powerhouse/document-model",
          name: "another-doc",
          parentFolder: FOLDER_SECOND,
          lastUpdated: new Date().toISOString(),
        },
      },
      folders: {
        [FOLDER_FIRST]: {
          name: "first folder",
          parentFolder: undefined, // root level
        },
        [FOLDER_NESTED]: {
          name: "nested folder",
          parentFolder: FOLDER_FIRST, // inside first folder
        },
        [FOLDER_SECOND]: {
          name: "second folder",
          parentFolder: undefined, // root level
        },
      },
      updatedAt: new Date().toISOString(),
    };

    await client.updateDriveManifest(DRIVE_ID, manifest);
    console.log("Drive manifest written");
  });

  // ─── 2. Read it back and verify full folder tree ──────────────

  it("should read back the drive manifest with complete folder hierarchy", async () => {
    const manifest = await waitForFeed(
      () => client.readDriveManifest(DRIVE_ID),
    );

    expect(manifest).not.toBeNull();
    expect(manifest!.driveId).toBe(DRIVE_ID);
    expect(manifest!.name).toBe("my drive");
    expect(manifest!.preferredEditor).toBe("GenericDriveExplorer");

    // 4 documents
    expect(Object.keys(manifest!.documents)).toHaveLength(4);

    // 3 folders
    expect(manifest!.folders).toBeDefined();
    expect(Object.keys(manifest!.folders!)).toHaveLength(3);

    // Verify folder hierarchy
    const folders = manifest!.folders!;
    expect(folders[FOLDER_FIRST].name).toBe("first folder");
    expect(folders[FOLDER_FIRST].parentFolder).toBeUndefined();

    expect(folders[FOLDER_NESTED].name).toBe("nested folder");
    expect(folders[FOLDER_NESTED].parentFolder).toBe(FOLDER_FIRST);

    expect(folders[FOLDER_SECOND].name).toBe("second folder");
    expect(folders[FOLDER_SECOND].parentFolder).toBeUndefined();

    // Verify document → folder assignments
    const docs = manifest!.documents;
    expect(docs[DOC_ROOT].parentFolder).toBeUndefined(); // drive root
    expect(docs[DOC_IN_FIRST].parentFolder).toBe(FOLDER_FIRST);
    expect(docs[DOC_DEEP].parentFolder).toBe(FOLDER_NESTED);
    expect(docs[DOC_IN_SECOND].parentFolder).toBe(FOLDER_SECOND);

    console.log("Drive manifest verified — full folder tree intact");
  });

  // ─── 3. Write user manifest with drive + docs ─────────────────

  it("should write user manifest with drive and all documents", async () => {
    const userManifest: SwarmUserManifest = {
      address: ownerAddress,
      documents: {
        [DRIVE_ID]: {
          documentType: "powerhouse/document-drive",
          name: "my drive",
          driveId: DRIVE_ID,
          lastUpdated: new Date().toISOString(),
        },
        [DOC_ROOT]: {
          documentType: "powerhouse/document-model",
          name: "root-doc",
          driveId: DRIVE_ID,
          lastUpdated: new Date().toISOString(),
        },
        [DOC_IN_FIRST]: {
          documentType: "powerhouse/document-model",
          name: "doc-in-first",
          driveId: DRIVE_ID,
          lastUpdated: new Date().toISOString(),
        },
        [DOC_DEEP]: {
          documentType: "powerhouse/document-model",
          name: "deep-doc",
          driveId: DRIVE_ID,
          lastUpdated: new Date().toISOString(),
        },
        [DOC_IN_SECOND]: {
          documentType: "powerhouse/document-model",
          name: "another-doc",
          driveId: DRIVE_ID,
          lastUpdated: new Date().toISOString(),
        },
      },
      drives: {
        [DRIVE_ID]: {
          name: "my drive",
          documentIds: [DOC_ROOT, DOC_IN_FIRST, DOC_DEEP, DOC_IN_SECOND],
          preferredEditor: "GenericDriveExplorer",
          lastUpdated: new Date().toISOString(),
        },
      },
      stamps: {},
      updatedAt: new Date().toISOString(),
    };

    await client.updateUserManifest(ownerAddress, userManifest);
    console.log("User manifest written");
  });

  // ─── 4. Read user manifest and verify drive linkage ───────────

  it("should read user manifest with all docs linked to correct drive", async () => {
    const manifest = await waitForFeed(
      () => client.readUserManifest(ownerAddress),
    );

    expect(manifest).not.toBeNull();

    // Drive exists
    expect(manifest!.drives[DRIVE_ID]).toBeDefined();
    expect(manifest!.drives[DRIVE_ID].name).toBe("my drive");
    expect(manifest!.drives[DRIVE_ID].documentIds).toHaveLength(4);

    // All documents link to the drive
    for (const docId of [DOC_ROOT, DOC_IN_FIRST, DOC_DEEP, DOC_IN_SECOND]) {
      expect(manifest!.documents[docId]).toBeDefined();
      expect(manifest!.documents[docId].driveId).toBe(DRIVE_ID);
    }

    // Drive entry is also in documents (as powerhouse/document-drive)
    expect(manifest!.documents[DRIVE_ID]).toBeDefined();
    expect(manifest!.documents[DRIVE_ID].documentType).toBe("powerhouse/document-drive");

    console.log("User manifest verified — all docs linked to drive");
  });

  // ─── 5. Verify drive manifest + user manifest consistency ─────

  it("should have consistent folder info between drive manifest and user manifest", async () => {
    const driveManifest = await client.readDriveManifest(DRIVE_ID);
    const userManifest = await client.readUserManifest(ownerAddress);

    expect(driveManifest).not.toBeNull();
    expect(userManifest).not.toBeNull();

    // Every doc in the drive manifest should be in the user manifest
    for (const docId of Object.keys(driveManifest!.documents)) {
      expect(userManifest!.documents[docId]).toBeDefined();
      expect(userManifest!.documents[docId].driveId).toBe(DRIVE_ID);
    }

    // Every doc in the user manifest with this driveId should be in the drive manifest
    for (const [docId, entry] of Object.entries(userManifest!.documents)) {
      if (entry.driveId === DRIVE_ID && entry.documentType !== "powerhouse/document-drive") {
        expect(driveManifest!.documents[docId]).toBeDefined();
      }
    }

    console.log("Cross-manifest consistency verified");
  });

  // ─── 6. Update: add a new folder and move a document ──────────

  it("should update drive manifest with a new folder and moved document", async () => {
    const manifest = await client.readDriveManifest(DRIVE_ID);
    expect(manifest).not.toBeNull();

    // Add a third-level folder inside nested folder
    const FOLDER_DEEP = `folder-deep-${Date.now().toString(36)}`;
    manifest!.folders![FOLDER_DEEP] = {
      name: "deep folder",
      parentFolder: FOLDER_NESTED,
    };

    // Move deep-doc into the new deep folder
    manifest!.documents[DOC_DEEP].parentFolder = FOLDER_DEEP;
    manifest!.updatedAt = new Date().toISOString();

    await client.updateDriveManifest(DRIVE_ID, manifest!);

    // Read back and verify
    await waitForPropagation(3000);
    const updated = await client.readDriveManifest(DRIVE_ID);
    expect(updated).not.toBeNull();
    expect(Object.keys(updated!.folders!)).toHaveLength(4); // was 3, now 4
    expect(updated!.folders![FOLDER_DEEP].name).toBe("deep folder");
    expect(updated!.folders![FOLDER_DEEP].parentFolder).toBe(FOLDER_NESTED);
    expect(updated!.documents[DOC_DEEP].parentFolder).toBe(FOLDER_DEEP);

    console.log("Drive manifest updated — 4 folders, doc moved to deep folder");
  });

  // ─── 7. Verify folder tree can be topologically sorted ────────

  it("should produce a valid topological sort of the folder tree", async () => {
    const manifest = await client.readDriveManifest(DRIVE_ID);
    expect(manifest).not.toBeNull();

    const folders = manifest!.folders!;
    const sorted: string[] = [];
    const added = new Set<string>();
    const visiting = new Set<string>();

    function addFolder(id: string): void {
      if (added.has(id)) return;
      if (visiting.has(id)) throw new Error(`Cycle detected at folder ${id}`);
      visiting.add(id);
      const parent = folders[id]?.parentFolder;
      if (parent && folders[parent] && !added.has(parent)) {
        addFolder(parent);
      }
      sorted.push(id);
      added.add(id);
      visiting.delete(id);
    }

    for (const id of Object.keys(folders)) {
      addFolder(id);
    }

    // Every folder's parent should appear before it in the sorted order
    for (const id of sorted) {
      const parent = folders[id]?.parentFolder;
      if (parent) {
        const parentIdx = sorted.indexOf(parent);
        const selfIdx = sorted.indexOf(id);
        expect(parentIdx).toBeLessThan(selfIdx);
      }
    }

    console.log(`Topological sort valid: ${sorted.map(id => folders[id].name).join(" → ")}`);
  });

  // ─── 8. Simulate document operations stored per-doc ───────────

  it("should store and retrieve document operations for each doc", async () => {
    // Write operations for root-doc
    const ops = [
      makeOperation(0, makeAction("SET_MODEL_NAME", { name: "root-doc" })),
      makeOperation(1, makeAction("SET_MODEL_DESCRIPTION", { description: "A doc at root" })),
      makeOperation(2, makeAction("SET_MODEL_ID", { id: "powerhouse/root-doc" })),
    ];

    const payload = JSON.stringify(ops);
    const { reference } = await client.uploadData(payload);

    // Write manifest pointing to ops
    await client.updateManifest(DOC_ROOT, {
      documentId: DOC_ROOT,
      documentType: "powerhouse/document-model",
      latestRevision: { global: 2 },
      operationBatches: [{
        reference,
        startIndex: 0,
        endIndex: 2,
        scope: "global",
        uploadedAt: new Date().toISOString(),
      }],
      keyframes: [],
      encrypted: false,
      updatedAt: new Date().toISOString(),
    });

    // Read back
    const docManifest = await waitForFeed(
      () => client.readManifest(DOC_ROOT),
    );

    expect(docManifest).not.toBeNull();
    expect(docManifest!.documentId).toBe(DOC_ROOT);
    expect(docManifest!.operationBatches).toHaveLength(1);
    expect(docManifest!.latestRevision.global).toBe(2);

    // Download and verify ops
    const downloaded = await client.downloadData(docManifest!.operationBatches[0].reference);
    const parsedOps = JSON.parse(new TextDecoder().decode(downloaded));
    expect(parsedOps).toHaveLength(3);
    expect(parsedOps[0].action.type).toBe("SET_MODEL_NAME");
    expect(parsedOps[1].action.type).toBe("SET_MODEL_DESCRIPTION");
    expect(parsedOps[2].action.type).toBe("SET_MODEL_ID");

    console.log("Document operations stored and retrieved for root-doc");
  });

  // ─── 9. Full round-trip: write everything, read as new device ─

  it("should support full discovery: user manifest → drive manifest → doc manifests → ops", async () => {
    // Simulate new device: start from just the owner address
    const userManifest = await client.readUserManifest(ownerAddress);
    expect(userManifest).not.toBeNull();

    // Discover drives
    const driveIds = Object.keys(userManifest!.drives);
    expect(driveIds).toContain(DRIVE_ID);

    // Read drive manifest
    const driveManifest = await client.readDriveManifest(DRIVE_ID);
    expect(driveManifest).not.toBeNull();

    // Discover all documents and their folder locations
    const docsInDrive = Object.entries(driveManifest!.documents);
    expect(docsInDrive.length).toBeGreaterThanOrEqual(4);

    // Build the folder tree
    const folders = driveManifest!.folders ?? {};
    const rootFolders = Object.entries(folders).filter(([, f]) => !f.parentFolder);
    const nestedFolders = Object.entries(folders).filter(([, f]) => !!f.parentFolder);

    expect(rootFolders.length).toBeGreaterThanOrEqual(2); // first folder, second folder
    expect(nestedFolders.length).toBeGreaterThanOrEqual(1); // nested folder (and possibly deep folder)

    // For each doc, verify we can read its manifest
    const docManifest = await client.readManifest(DOC_ROOT);
    expect(docManifest).not.toBeNull();
    expect(docManifest!.operationBatches.length).toBeGreaterThanOrEqual(1);

    // Download ops
    const opsData = await client.downloadData(docManifest!.operationBatches[0].reference);
    const ops = JSON.parse(new TextDecoder().decode(opsData));
    expect(ops.length).toBeGreaterThanOrEqual(1);

    console.log(`Full discovery: ${driveIds.length} drives, ${docsInDrive.length} docs, ${Object.keys(folders).length} folders, ${ops.length} ops`);
  });

  // ─── 10. Clean up: write empty manifests ──────────────────────

  it("should clean up test data by writing empty manifests", async () => {
    // Empty user manifest
    await client.updateUserManifest(ownerAddress, {
      address: ownerAddress,
      documents: {},
      drives: {},
      stamps: {},
      updatedAt: new Date().toISOString(),
    });

    // Empty drive manifest
    await client.updateDriveManifest(DRIVE_ID, {
      driveId: DRIVE_ID,
      name: "",
      documents: {},
      folders: {},
      updatedAt: new Date().toISOString(),
    });

    await waitForPropagation(2000);

    const userManifest = await client.readUserManifest(ownerAddress);
    expect(Object.keys(userManifest!.documents)).toHaveLength(0);

    console.log("Test data cleaned up");
  });
});
