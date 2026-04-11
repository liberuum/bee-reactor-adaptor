/**
 * Integration test: Production-scale drive tree
 *
 * Tests with the exact structure from the user's live Powerhouse RGH environment:
 *
 *   Powerhouse RGH Operator Admin/
 *     ├── Services And Offerings/
 *     │   ├── Products/
 *     │   │   ├── COMMERCIAL OPERATIONAL HUB (resource-template)
 *     │   │   ├── NETWORK OPERATIONAL HUB (resource-template)
 *     │   │   └── REVENUE GENERATING HUB (resource-template)
 *     │   └── Service Offerings/
 *     │       ├── Operational Hub (service-offering)
 *     │       └── AgenticOps (service-offering)
 *     ├── Service Subscriptions/
 *     │   ├── yasiel-testing123/
 *     │   │   ├── Subscription Instance (subscription-instance)
 *     │   │   └── Resource Instance (resource-instance)
 *     │   ├── Powerhouse/
 *     │   │   ├── Subscription Instance (subscription-instance)
 *     │   │   └── Resource Instance (resource-instance)
 *     │   ├── t-team Subscription (subscription-instance)  ← root of Service Subscriptions
 *     │   └── t-team Resource (resource-instance)          ← root of Service Subscriptions
 *     ├── Snapshot Reports/  ← empty folder
 *     ├── Expense Reports/   ← empty folder
 *     └── Powerhouse RGH (builder-profile)  ← drive root doc
 *
 * Tests: write to Swarm → read back → verify full tree → topological sort → batch generation
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SwarmClient } from "../../src/swarm-client.js";
import type { SwarmDriveManifest, DriveFolderEntry } from "../../src/types.js";
import { preflight, waitForFeed, waitForPropagation, BEE_URL, TEST_SIGNER_KEY } from "../helpers.js";

const RUN = Date.now().toString(36);
const DRIVE_ID = `rgh-drive-${RUN}`;

// Folders (11 total, 4 levels deep)
const F_SERVICES = `f-services-${RUN}`;
const F_PRODUCTS = `f-products-${RUN}`;
const F_OFFERINGS = `f-offerings-${RUN}`;
const F_SUBSCRIPTIONS = `f-subscriptions-${RUN}`;
const F_YASIEL_123 = `f-yasiel123-${RUN}`;
const F_POWERHOUSE = `f-powerhouse-${RUN}`;
const F_SNAPSHOTS = `f-snapshots-${RUN}`;       // empty
const F_EXPENSES = `f-expenses-${RUN}`;          // empty

// Docs (12 total at various nesting levels)
const DOC_PROFILE = `doc-profile-${RUN}`;         // drive root
const DOC_COMM_OH = `doc-comm-oh-${RUN}`;         // Products/
const DOC_NET_OH = `doc-net-oh-${RUN}`;           // Products/
const DOC_RGH = `doc-rgh-${RUN}`;                 // Products/
const DOC_OP_HUB = `doc-op-hub-${RUN}`;           // Service Offerings/
const DOC_AGENTIC = `doc-agentic-${RUN}`;         // Service Offerings/
const DOC_Y123_SUB = `doc-y123-sub-${RUN}`;       // yasiel-testing123/
const DOC_Y123_RES = `doc-y123-res-${RUN}`;       // yasiel-testing123/
const DOC_PH_SUB = `doc-ph-sub-${RUN}`;           // Powerhouse/
const DOC_PH_RES = `doc-ph-res-${RUN}`;           // Powerhouse/
const DOC_TTEAM_SUB = `doc-tteam-sub-${RUN}`;     // Service Subscriptions/ (root)
const DOC_TTEAM_RES = `doc-tteam-res-${RUN}`;     // Service Subscriptions/ (root)

let client: SwarmClient;

describe("Production-scale drive tree", () => {
  beforeAll(async () => {
    const { batchId } = await preflight();
    client = new SwarmClient({
      beeUrl: BEE_URL,
      batchId,
      signerPrivateKey: TEST_SIGNER_KEY,
      useFeedMode: true,
      feedTopicPrefix: "test:rgh",
      useEncryption: false,
    });
  });

  it("should write a production-scale drive manifest", async () => {
    const now = new Date().toISOString();

    const manifest: SwarmDriveManifest = {
      driveId: DRIVE_ID,
      name: "Powerhouse RGH Operator Admin",
      preferredEditor: "builder-team-admin",
      folders: {
        [F_SERVICES]:      { name: "Services And Offerings" },
        [F_PRODUCTS]:       { name: "Products", parentFolder: F_SERVICES },
        [F_OFFERINGS]:      { name: "Service Offerings", parentFolder: F_SERVICES },
        [F_SUBSCRIPTIONS]:  { name: "Service Subscriptions" },
        [F_YASIEL_123]:     { name: "yasiel-testing123", parentFolder: F_SUBSCRIPTIONS },
        [F_POWERHOUSE]:     { name: "Powerhouse", parentFolder: F_SUBSCRIPTIONS },
        [F_SNAPSHOTS]:      { name: "Snapshot Reports" },
        [F_EXPENSES]:       { name: "Expense Reports" },
      },
      documents: {
        [DOC_PROFILE]:    { documentType: "powerhouse/builder-profile", name: "Powerhouse RGH", lastUpdated: now },
        [DOC_COMM_OH]:    { documentType: "powerhouse/resource-template", name: "COMMERCIAL OPERATIONAL HUB (OH)", parentFolder: F_PRODUCTS, lastUpdated: now },
        [DOC_NET_OH]:     { documentType: "powerhouse/resource-template", name: "NETWORK OPERATIONAL HUB", parentFolder: F_PRODUCTS, lastUpdated: now },
        [DOC_RGH]:        { documentType: "powerhouse/resource-template", name: "REVENUE GENERATING HUB (RGH)", parentFolder: F_PRODUCTS, lastUpdated: now },
        [DOC_OP_HUB]:     { documentType: "powerhouse/service-offering", name: "Operational Hub", parentFolder: F_OFFERINGS, lastUpdated: now },
        [DOC_AGENTIC]:    { documentType: "powerhouse/service-offering", name: "AgenticOps", parentFolder: F_OFFERINGS, lastUpdated: now },
        [DOC_Y123_SUB]:   { documentType: "powerhouse/subscription-instance", name: "yasiel-testing123 Subscription Instance", parentFolder: F_YASIEL_123, lastUpdated: now },
        [DOC_Y123_RES]:   { documentType: "powerhouse/resource-instance", name: "yasiel-testing123 Resource Instance", parentFolder: F_YASIEL_123, lastUpdated: now },
        [DOC_PH_SUB]:     { documentType: "powerhouse/subscription-instance", name: "powerhouse Subscription Instance", parentFolder: F_POWERHOUSE, lastUpdated: now },
        [DOC_PH_RES]:     { documentType: "powerhouse/resource-instance", name: "powerhouse Resource Instance", parentFolder: F_POWERHOUSE, lastUpdated: now },
        [DOC_TTEAM_SUB]:  { documentType: "powerhouse/subscription-instance", name: "t-team Subscription Instance", parentFolder: F_SUBSCRIPTIONS, lastUpdated: now },
        [DOC_TTEAM_RES]:  { documentType: "powerhouse/resource-instance", name: "t-team Resource Instance", parentFolder: F_SUBSCRIPTIONS, lastUpdated: now },
      },
      updatedAt: now,
    };

    await client.updateDriveManifest(DRIVE_ID, manifest);
    console.log("Production drive manifest written: 8 folders, 12 docs");
  });

  it("should read back the full production tree from Swarm", async () => {
    const m = await waitForFeed(() => client.readDriveManifest(DRIVE_ID));
    expect(m).not.toBeNull();

    expect(m!.name).toBe("Powerhouse RGH Operator Admin");
    expect(m!.preferredEditor).toBe("builder-team-admin");
    expect(Object.keys(m!.folders!)).toHaveLength(8);
    expect(Object.keys(m!.documents)).toHaveLength(12);

    const folders = m!.folders!;

    // Level 1: root folders
    const rootFolders = Object.entries(folders).filter(([, f]) => !f.parentFolder);
    expect(rootFolders).toHaveLength(4); // Services, Subscriptions, Snapshots, Expenses
    const rootNames = rootFolders.map(([, f]) => f.name).sort();
    expect(rootNames).toEqual(["Expense Reports", "Service Subscriptions", "Services And Offerings", "Snapshot Reports"]);

    // Level 2: inside Services And Offerings
    const servicesChildren = Object.entries(folders).filter(([, f]) => f.parentFolder === F_SERVICES);
    expect(servicesChildren).toHaveLength(2); // Products, Service Offerings

    // Level 2: inside Service Subscriptions
    const subsChildren = Object.entries(folders).filter(([, f]) => f.parentFolder === F_SUBSCRIPTIONS);
    expect(subsChildren).toHaveLength(2); // yasiel-testing123, Powerhouse

    // Level 3: Products has 3 docs
    const productsDocNames = Object.values(m!.documents)
      .filter(d => d.parentFolder === F_PRODUCTS)
      .map(d => d.name)
      .sort();
    expect(productsDocNames).toEqual([
      "COMMERCIAL OPERATIONAL HUB (OH)",
      "NETWORK OPERATIONAL HUB",
      "REVENUE GENERATING HUB (RGH)",
    ]);

    // Empty folders exist
    expect(folders[F_SNAPSHOTS].name).toBe("Snapshot Reports");
    expect(folders[F_EXPENSES].name).toBe("Expense Reports");
    const snapshotDocs = Object.values(m!.documents).filter(d => d.parentFolder === F_SNAPSHOTS);
    expect(snapshotDocs).toHaveLength(0);

    // Docs at root of Service Subscriptions (not in a sub-folder)
    const subRootDocs = Object.values(m!.documents)
      .filter(d => d.parentFolder === F_SUBSCRIPTIONS)
      .map(d => d.name)
      .sort();
    expect(subRootDocs).toEqual(["t-team Resource Instance", "t-team Subscription Instance"]);

    // Drive root doc (no parentFolder)
    const rootDocs = Object.values(m!.documents).filter(d => !d.parentFolder);
    expect(rootDocs).toHaveLength(1);
    expect(rootDocs[0].name).toBe("Powerhouse RGH");

    console.log("Full production tree verified: 4 root folders, 4 sub-folders, 12 docs at various levels");
  });

  it("should generate correct batch actions for hydration", async () => {
    const m = await client.readDriveManifest(DRIVE_ID);
    const folders = m!.folders!;
    const docs = m!.documents;

    // Topological sort
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

    // All ADD_FOLDER actions
    const folderActions = sorted.map(([folderId, folder]) => ({
      type: "ADD_FOLDER" as const,
      input: {
        id: folderId,
        name: folder.name,
        ...(folder.parentFolder ? { parentFolder: folder.parentFolder } : {}),
      },
    }));

    // All ADD_FILE actions with parentFolder
    const fileActions = Object.entries(docs).map(([docId, doc]) => ({
      type: "ADD_FILE" as const,
      input: {
        id: docId,
        name: doc.name,
        documentType: doc.documentType,
        ...(doc.parentFolder ? { parentFolder: doc.parentFolder } : {}),
      },
    }));

    const batch = [...folderActions, ...fileActions];
    expect(batch).toHaveLength(20); // 8 folders + 12 files

    // Verify topological order: every folder's parent appears before it
    const folderOrder = folderActions.map(a => a.input.id);
    for (const action of folderActions) {
      if (action.input.parentFolder) {
        const parentIdx = folderOrder.indexOf(action.input.parentFolder);
        const selfIdx = folderOrder.indexOf(action.input.id);
        expect(parentIdx).toBeLessThan(selfIdx);
      }
    }

    // Verify every file's parentFolder references an existing folder action
    for (const action of fileActions) {
      if (action.input.parentFolder) {
        expect(folderOrder).toContain(action.input.parentFolder);
      }
    }

    // Print the tree for visual verification
    function printTree(parentId: string | null, indent: string): string[] {
      const lines: string[] = [];
      const childFolders = sorted.filter(([, f]) => (f.parentFolder || null) === parentId);
      const childDocs = Object.entries(docs).filter(([, d]) => (d.parentFolder || null) === parentId);
      for (const [fId, f] of childFolders) {
        lines.push(`${indent}📁 ${f.name}/`);
        lines.push(...printTree(fId, indent + "  "));
      }
      for (const [, d] of childDocs) {
        lines.push(`${indent}${d.name} (${d.documentType.split("/")[1]})`);
      }
      return lines;
    }

    const tree = printTree(null, "  ");
    console.log("Generated tree:");
    console.log(`${m!.name}/`);
    tree.forEach(l => console.log(l));
  });

  it("should match the recursive tree builder output", async () => {
    const m = await client.readDriveManifest(DRIVE_ID);
    const folders = m!.folders!;
    const docs = m!.documents;

    // Same algorithm as documents.tsx buildFolderTree()
    function buildTree(parentId: string | null): { folders: string[]; docs: string[] } {
      const childFolders = Object.entries(folders)
        .filter(([, f]) => (f.parentFolder || null) === parentId)
        .sort(([, a], [, b]) => a.name.localeCompare(b.name));
      const childDocs = Object.entries(docs)
        .filter(([, d]) => (d.parentFolder || null) === parentId)
        .map(([, d]) => d.name);
      const result: { folders: string[]; docs: string[] } = { folders: [], docs: childDocs };
      for (const [fId, f] of childFolders) {
        const sub = buildTree(fId);
        result.folders.push(f.name);
        result.folders.push(...sub.folders.map(n => `  ${n}`));
        result.docs.push(...sub.docs.map(n => `  ${n}`));
      }
      return result;
    }

    const tree = buildTree(null);

    // Root level
    expect(tree.docs.filter(d => !d.startsWith("  "))).toEqual(["Powerhouse RGH"]);
    expect(tree.folders.filter(f => !f.startsWith("  "))).toHaveLength(4);

    // Total docs reachable through the tree
    const allDocs = tree.docs.map(d => d.trim());
    expect(allDocs).toHaveLength(12);
  });

  it("should clean up", async () => {
    await client.updateDriveManifest(DRIVE_ID, {
      driveId: DRIVE_ID, name: "", documents: {}, folders: {}, updatedAt: new Date().toISOString(),
    });
    await waitForPropagation(2000);
    console.log("Cleaned up");
  });
});
