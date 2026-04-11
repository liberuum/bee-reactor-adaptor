/**
 * Integration tests: Drive hydration round-trip
 *
 * Tests the FULL cycle:
 * 1. Build a drive manifest with nested folders + docs (simulating flush.ts capture)
 * 2. Store document operations on Swarm
 * 3. Read everything back (simulating hydration discovery)
 * 4. Verify the folder tree can be reconstructed via topological sort
 * 5. Generate the correct ADD_FOLDER + ADD_FILE batch actions for the reactor
 * 6. Verify the batch would produce the original structure
 *
 * Structure:
 *   my drive/
 *     ├── root-doc
 *     ├── folder-a/
 *     │   ├── doc-in-a
 *     │   └── folder-b/  (nested inside folder-a)
 *     │       └── doc-in-b
 *     └── folder-c/
 *         └── doc-in-c
 *
 * Requires live Bee node: BEE_URL="https://your-node:1633" bunx vitest run
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SwarmClient } from "../../src/swarm-client.js";
import type { SwarmDriveManifest, SwarmUserManifest, DriveFolderEntry } from "../../src/types.js";
import { preflight, waitForFeed, waitForPropagation, BEE_URL, TEST_SIGNER_KEY, makeAction, makeOperation } from "../helpers.js";

// ─── Deterministic IDs ─────────────────────────────────────────

const RUN = Date.now().toString(36);
const DRIVE_ID = `hydra-drive-${RUN}`;
const FOLDER_A = `hydra-folder-a-${RUN}`;
const FOLDER_B = `hydra-folder-b-${RUN}`;
const FOLDER_C = `hydra-folder-c-${RUN}`;
const DOC_ROOT = `hydra-doc-root-${RUN}`;
const DOC_IN_A = `hydra-doc-in-a-${RUN}`;
const DOC_IN_B = `hydra-doc-in-b-${RUN}`;
const DOC_IN_C = `hydra-doc-in-c-${RUN}`;

let client: SwarmClient;
let ownerAddress: string;

describe("Drive hydration round-trip", () => {
  beforeAll(async () => {
    const { batchId } = await preflight();
    client = new SwarmClient({
      beeUrl: BEE_URL,
      batchId,
      signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: true,
      feedTopicPrefix: "test:hydration",
      useEncryption: false,
    });
    ownerAddress = client.getOwnerAddress();
  });

  // ─── Phase 1: Simulate what flush.ts does ─────────────────────
  // Capture the drive state → build drive manifest → write to Swarm

  it("should build a drive manifest from simulated drive nodes", () => {
    // Simulating what flush.ts reads from driveDoc.state.global.nodes
    const nodes = [
      { id: FOLDER_A, kind: "folder", name: "folder-a", parentFolder: null },
      { id: FOLDER_B, kind: "folder", name: "folder-b", parentFolder: FOLDER_A },
      { id: FOLDER_C, kind: "folder", name: "folder-c", parentFolder: null },
      { id: DOC_ROOT, kind: "file", name: "root-doc", documentType: "powerhouse/document-model", parentFolder: null },
      { id: DOC_IN_A, kind: "file", name: "doc-in-a", documentType: "powerhouse/document-model", parentFolder: FOLDER_A },
      { id: DOC_IN_B, kind: "file", name: "doc-in-b", documentType: "powerhouse/document-model", parentFolder: FOLDER_B },
      { id: DOC_IN_C, kind: "file", name: "doc-in-c", documentType: "powerhouse/document-model", parentFolder: FOLDER_C },
    ];

    // This is the logic from flush.ts lines 421-436
    const folders: Record<string, { name: string; parentFolder?: string }> = {};
    const documents: Record<string, { documentType: string; name: string; parentFolder?: string; lastUpdated: string }> = {};
    const now = new Date().toISOString();

    for (const node of nodes) {
      if (node.kind === "folder" && node.id) {
        folders[node.id] = {
          name: node.name,
          parentFolder: node.parentFolder || undefined,
        };
      }
      if (node.kind === "file" && node.id) {
        documents[node.id] = {
          documentType: node.documentType!,
          name: node.name,
          parentFolder: node.parentFolder || undefined,
          lastUpdated: now,
        };
      }
    }

    // Verify capture is complete
    expect(Object.keys(folders)).toHaveLength(3);
    expect(Object.keys(documents)).toHaveLength(4);

    // Verify parentFolder chain
    expect(folders[FOLDER_A].parentFolder).toBeUndefined(); // root
    expect(folders[FOLDER_B].parentFolder).toBe(FOLDER_A);  // nested
    expect(folders[FOLDER_C].parentFolder).toBeUndefined(); // root

    expect(documents[DOC_ROOT].parentFolder).toBeUndefined();
    expect(documents[DOC_IN_A].parentFolder).toBe(FOLDER_A);
    expect(documents[DOC_IN_B].parentFolder).toBe(FOLDER_B);
    expect(documents[DOC_IN_C].parentFolder).toBe(FOLDER_C);

    console.log("Flush capture simulation: 3 folders, 4 docs — parentFolder chains correct");
  });

  // ─── Phase 2: Write to Swarm ──────────────────────────────────

  it("should write drive manifest + user manifest + doc operations to Swarm", async () => {
    const now = new Date().toISOString();

    // Drive manifest
    const driveManifest: SwarmDriveManifest = {
      driveId: DRIVE_ID,
      name: "my drive",
      preferredEditor: "GenericDriveExplorer",
      documents: {
        [DOC_ROOT]: { documentType: "powerhouse/document-model", name: "root-doc", parentFolder: undefined, lastUpdated: now },
        [DOC_IN_A]: { documentType: "powerhouse/document-model", name: "doc-in-a", parentFolder: FOLDER_A, lastUpdated: now },
        [DOC_IN_B]: { documentType: "powerhouse/document-model", name: "doc-in-b", parentFolder: FOLDER_B, lastUpdated: now },
        [DOC_IN_C]: { documentType: "powerhouse/document-model", name: "doc-in-c", parentFolder: FOLDER_C, lastUpdated: now },
      },
      folders: {
        [FOLDER_A]: { name: "folder-a", parentFolder: undefined },
        [FOLDER_B]: { name: "folder-b", parentFolder: FOLDER_A },
        [FOLDER_C]: { name: "folder-c", parentFolder: undefined },
      },
      updatedAt: now,
    };

    await client.updateDriveManifest(DRIVE_ID, driveManifest);

    // User manifest
    const userManifest: SwarmUserManifest = {
      address: ownerAddress,
      documents: {
        [DRIVE_ID]: { documentType: "powerhouse/document-drive", name: "my drive", driveId: DRIVE_ID, lastUpdated: now },
        [DOC_ROOT]: { documentType: "powerhouse/document-model", name: "root-doc", driveId: DRIVE_ID, lastUpdated: now },
        [DOC_IN_A]: { documentType: "powerhouse/document-model", name: "doc-in-a", driveId: DRIVE_ID, lastUpdated: now },
        [DOC_IN_B]: { documentType: "powerhouse/document-model", name: "doc-in-b", driveId: DRIVE_ID, lastUpdated: now },
        [DOC_IN_C]: { documentType: "powerhouse/document-model", name: "doc-in-c", driveId: DRIVE_ID, lastUpdated: now },
      },
      drives: {
        [DRIVE_ID]: { name: "my drive", documentIds: [DOC_ROOT, DOC_IN_A, DOC_IN_B, DOC_IN_C], preferredEditor: "GenericDriveExplorer", lastUpdated: now },
      },
      stamps: {},
      updatedAt: now,
    };

    await client.updateUserManifest(ownerAddress, userManifest);

    // Doc operations (one batch per doc)
    for (const [docId, docName] of [[DOC_ROOT, "root-doc"], [DOC_IN_A, "doc-in-a"], [DOC_IN_B, "doc-in-b"], [DOC_IN_C, "doc-in-c"]] as const) {
      const ops = [
        makeOperation(0, makeAction("SET_MODEL_NAME", { name: docName })),
        makeOperation(1, makeAction("SET_MODEL_DESCRIPTION", { description: `Description for ${docName}` })),
      ];
      const { reference } = await client.uploadData(JSON.stringify(ops));
      await client.updateManifest(docId, {
        documentId: docId,
        documentType: "powerhouse/document-model",
        latestRevision: { global: 1 },
        operationBatches: [{ reference, startIndex: 0, endIndex: 1, scope: "global", uploadedAt: now }],
        keyframes: [],
        encrypted: false,
        updatedAt: now,
      });
    }

    console.log("All data written to Swarm");
  });

  // ─── Phase 3: Simulate hydration discovery ────────────────────

  it("should discover the full structure from user manifest → drive manifest", async () => {
    // Step 1: Read user manifest (what hydration does first)
    const userManifest = await waitForFeed(() => client.readUserManifest(ownerAddress));
    expect(userManifest).not.toBeNull();

    // Step 2: Find drives
    const driveEntries = Object.entries(userManifest!.drives);
    expect(driveEntries).toHaveLength(1);
    expect(driveEntries[0][0]).toBe(DRIVE_ID);

    // Step 3: Read drive manifest
    const driveManifest = await client.readDriveManifest(DRIVE_ID);
    expect(driveManifest).not.toBeNull();

    // Step 4: Group docs by drive
    const docsInDrive = Object.entries(userManifest!.documents)
      .filter(([, e]) => e.driveId === DRIVE_ID && e.documentType !== "powerhouse/document-drive");
    expect(docsInDrive).toHaveLength(4);

    // Step 5: Get folder info from drive manifest
    const folders = driveManifest!.folders ?? {};
    expect(Object.keys(folders)).toHaveLength(3);

    console.log(`Discovery: 1 drive, ${docsInDrive.length} docs, ${Object.keys(folders).length} folders`);
  });

  // ─── Phase 4: Generate hydration batch actions ────────────────

  it("should generate correct ADD_FOLDER actions in topological order", async () => {
    const driveManifest = await client.readDriveManifest(DRIVE_ID);
    const folders = driveManifest!.folders!;

    // Topological sort (same logic as restoreFolderStructure)
    const sorted: Array<[string, DriveFolderEntry]> = [];
    const added = new Set<string>();
    const visiting = new Set<string>();

    function addFolder(id: string, folder: DriveFolderEntry): void {
      if (added.has(id)) return;
      if (visiting.has(id)) return;
      visiting.add(id);
      if (folder.parentFolder && folders[folder.parentFolder] && !added.has(folder.parentFolder)) {
        addFolder(folder.parentFolder, folders[folder.parentFolder]);
      }
      sorted.push([id, folder]);
      added.add(id);
      visiting.delete(id);
    }
    for (const [id, folder] of Object.entries(folders)) addFolder(id, folder);

    // Generate ADD_FOLDER actions
    const folderActions = sorted.map(([folderId, folder]) => ({
      id: crypto.randomUUID(),
      timestampUtcMs: new Date().toISOString(),
      type: "ADD_FOLDER",
      input: {
        id: folderId,
        name: folder.name,
        ...(folder.parentFolder ? { parentFolder: folder.parentFolder } : {}),
      },
      scope: "global",
    }));

    // Verify order: folder-a must come before folder-b
    const names = folderActions.map(a => a.input.name);
    const idxA = names.indexOf("folder-a");
    const idxB = names.indexOf("folder-b");
    expect(idxA).toBeLessThan(idxB);

    // Verify all 3 folders present
    expect(folderActions).toHaveLength(3);

    // Verify parentFolder is correct
    const bAction = folderActions.find(a => a.input.name === "folder-b");
    expect(bAction!.input.parentFolder).toBe(FOLDER_A);

    const aAction = folderActions.find(a => a.input.name === "folder-a");
    expect(aAction!.input).not.toHaveProperty("parentFolder");

    console.log(`ADD_FOLDER actions: ${names.join(" → ")}`);
  });

  // ─── Phase 5: Generate ADD_FILE actions with parentFolder ─────
  // This is the KEY test — documents should be placed directly in
  // their folder via ADD_FILE, not created at root and moved.

  it("should generate ADD_FILE actions with correct parentFolder for each doc", async () => {
    const driveManifest = await client.readDriveManifest(DRIVE_ID);
    const docs = driveManifest!.documents;

    // Generate ADD_FILE actions (what the reactor needs)
    const fileActions = Object.entries(docs).map(([docId, doc]) => ({
      id: crypto.randomUUID(),
      timestampUtcMs: new Date().toISOString(),
      type: "ADD_FILE",
      input: {
        id: docId,
        name: doc.name,
        documentType: doc.documentType,
        ...(doc.parentFolder ? { parentFolder: doc.parentFolder } : {}),
      },
      scope: "global",
    }));

    expect(fileActions).toHaveLength(4);

    // root-doc should NOT have parentFolder
    const rootAction = fileActions.find(a => a.input.name === "root-doc");
    expect(rootAction).toBeDefined();
    expect(rootAction!.input).not.toHaveProperty("parentFolder");

    // doc-in-a should have parentFolder = FOLDER_A
    const docAAction = fileActions.find(a => a.input.name === "doc-in-a");
    expect(docAAction!.input.parentFolder).toBe(FOLDER_A);

    // doc-in-b should have parentFolder = FOLDER_B (nested!)
    const docBAction = fileActions.find(a => a.input.name === "doc-in-b");
    expect(docBAction!.input.parentFolder).toBe(FOLDER_B);

    // doc-in-c should have parentFolder = FOLDER_C
    const docCAction = fileActions.find(a => a.input.name === "doc-in-c");
    expect(docCAction!.input.parentFolder).toBe(FOLDER_C);

    console.log("ADD_FILE actions all have correct parentFolder assignments");
  });

  // ─── Phase 6: Full batch action sequence ──────────────────────

  it("should produce the correct complete batch for reactor.execute()", async () => {
    const driveManifest = await client.readDriveManifest(DRIVE_ID);
    const folders = driveManifest!.folders!;
    const docs = driveManifest!.documents;

    // Step 1: ADD_FOLDER in topological order
    const sorted: Array<[string, DriveFolderEntry]> = [];
    const added = new Set<string>();
    function addF(id: string): void {
      if (added.has(id)) return;
      const f = folders[id];
      if (f.parentFolder && folders[f.parentFolder] && !added.has(f.parentFolder)) addF(f.parentFolder);
      sorted.push([id, f]);
      added.add(id);
    }
    for (const id of Object.keys(folders)) addF(id);

    const batch: any[] = [];

    for (const [folderId, folder] of sorted) {
      batch.push({
        id: crypto.randomUUID(),
        timestampUtcMs: new Date().toISOString(),
        type: "ADD_FOLDER",
        input: { id: folderId, name: folder.name, ...(folder.parentFolder ? { parentFolder: folder.parentFolder } : {}) },
        scope: "global",
      });
    }

    // Step 2: ADD_FILE with parentFolder (NOT at root + MOVE_NODE)
    for (const [docId, doc] of Object.entries(docs)) {
      batch.push({
        id: crypto.randomUUID(),
        timestampUtcMs: new Date().toISOString(),
        type: "ADD_FILE",
        input: { id: docId, name: doc.name, documentType: doc.documentType, ...(doc.parentFolder ? { parentFolder: doc.parentFolder } : {}) },
        scope: "global",
      });
    }

    // Verify batch integrity
    expect(batch).toHaveLength(7); // 3 folders + 4 files

    // All ADD_FOLDER must come before any ADD_FILE that references that folder
    for (const action of batch) {
      if (action.type === "ADD_FILE" && action.input.parentFolder) {
        const folderActionIdx = batch.findIndex(a => a.type === "ADD_FOLDER" && a.input.id === action.input.parentFolder);
        const fileActionIdx = batch.indexOf(action);
        expect(folderActionIdx).toBeGreaterThanOrEqual(0);
        expect(folderActionIdx).toBeLessThan(fileActionIdx);
      }
    }

    // No MOVE_NODE actions needed!
    const moveActions = batch.filter(a => a.type === "MOVE_NODE");
    expect(moveActions).toHaveLength(0);

    console.log(`Batch: ${batch.map(a => `${a.type}(${a.input.name || a.input.id?.slice(0, 8)})`).join(", ")}`);
    console.log("No MOVE_NODE needed — files placed directly in folders via ADD_FILE");
  });

  // ─── Phase 7: Download ops and verify per-doc ─────────────────

  it("should download and verify operations for all 4 documents", async () => {
    for (const [docId, expectedName] of [[DOC_ROOT, "root-doc"], [DOC_IN_A, "doc-in-a"], [DOC_IN_B, "doc-in-b"], [DOC_IN_C, "doc-in-c"]] as const) {
      const manifest = await waitForFeed(() => client.readManifest(docId));
      expect(manifest).not.toBeNull();
      expect(manifest!.operationBatches).toHaveLength(1);

      const raw = await client.downloadData(manifest!.operationBatches[0].reference);
      const ops = JSON.parse(new TextDecoder().decode(raw));
      expect(ops).toHaveLength(2);
      expect(ops[0].action.input.name).toBe(expectedName);
    }

    console.log("All 4 doc operations verified");
  });

  // ─── Cleanup ──────────────────────────────────────────────────

  it("should clean up all test data", async () => {
    await client.updateUserManifest(ownerAddress, {
      address: ownerAddress, documents: {}, drives: {}, stamps: {}, updatedAt: new Date().toISOString(),
    });
    await client.updateDriveManifest(DRIVE_ID, {
      driveId: DRIVE_ID, name: "", documents: {}, folders: {}, updatedAt: new Date().toISOString(),
    });
    for (const docId of [DOC_ROOT, DOC_IN_A, DOC_IN_B, DOC_IN_C]) {
      await client.updateManifest(docId, {
        documentId: docId, documentType: "", latestRevision: {}, operationBatches: [], keyframes: [], updatedAt: new Date().toISOString(),
      });
    }
    await waitForPropagation(2000);
    console.log("Cleaned up");
  });
});
