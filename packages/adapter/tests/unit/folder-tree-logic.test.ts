/**
 * Unit tests: Folder tree display logic
 *
 * Tests the exact same tree-building logic used by the Settings UI
 * (documents.tsx DocsTreeSection) to verify it correctly groups
 * documents into nested folders.
 *
 * No Bee node needed — pure logic tests.
 */
import { describe, it, expect } from "vitest";

// ─── Replicate the UI's tree-building logic ─────────────────────

type DocEntry = { name?: string; documentType?: string; driveId?: string; parentFolder?: string };
type FolderEntry = { name: string; parentFolder?: string };

/**
 * Recursive tree builder — same algorithm as documents.tsx buildFolderTree()
 * and sharing.tsx buildShareTree(). Matches parentFolder === null for root.
 */
function buildFolderTree(
  parentId: string | null,
  folders: Record<string, FolderEntry>,
  docs: Array<[string, DocEntry]>,
): { subFolders: Array<{ id: string; name: string; subFolders: any[]; docs: string[] }>; docs: string[] } {
  const matchingFolders = Object.entries(folders)
    .filter(([, f]) => (f.parentFolder || null) === parentId)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const matchingDocs = docs
    .filter(([, d]) => (d.parentFolder || null) === parentId)
    .map(([, d]) => d.name!);
  const subFolders = matchingFolders.map(([id, f]) => {
    const children = buildFolderTree(id, folders, docs);
    return { id, name: f.name, subFolders: children.subFolders, docs: children.docs };
  });
  return { subFolders, docs: matchingDocs };
}

function buildTree(
  docs: Array<[string, DocEntry]>,
  driveManifests?: Record<string, { folders?: Record<string, FolderEntry> }>,
) {
  const drives = docs.filter(([, d]) => d.documentType === "powerhouse/document-drive");
  const childDocs = docs.filter(([, d]) => d.documentType !== "powerhouse/document-drive");
  const driveIds = new Set(drives.map(([id]) => id));

  const driveChildren = new Map<string, typeof childDocs>();
  const orphans: typeof childDocs = [];
  for (const entry of childDocs) {
    const driveId = entry[1].driveId;
    if (driveId && driveIds.has(driveId)) {
      const existing = driveChildren.get(driveId) ?? [];
      existing.push(entry);
      driveChildren.set(driveId, existing);
    } else {
      orphans.push(entry);
    }
  }

  const result: Record<string, {
    driveName: string;
    rootFolders: Array<{ id: string; name: string; subFolders: any[]; docs: string[] }>;
    rootDocs: string[];
  }> = {};

  for (const [driveId, drive] of drives) {
    const children = driveChildren.get(driveId) ?? [];
    const folders = driveManifests?.[driveId]?.folders ?? {};
    const tree = buildFolderTree(null, folders, children);
    result[driveId] = {
      driveName: drive.name!,
      rootFolders: tree.subFolders,
      rootDocs: tree.docs,
    };
  }

  return { result, orphans: orphans.map(([, d]) => d.name!) };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Folder tree display logic", () => {

  it("should group docs under a flat drive (no folders)", () => {
    const docs: Array<[string, DocEntry]> = [
      ["drive-1", { name: "My Drive", documentType: "powerhouse/document-drive" }],
      ["doc-1", { name: "Doc A", documentType: "powerhouse/document-model", driveId: "drive-1" }],
      ["doc-2", { name: "Doc B", documentType: "powerhouse/document-model", driveId: "drive-1" }],
    ];

    const { result } = buildTree(docs);
    expect(result["drive-1"].rootDocs).toEqual(["Doc A", "Doc B"]);
    expect(result["drive-1"].rootFolders).toHaveLength(0);
  });

  it("should group docs under root-level folders", () => {
    const docs: Array<[string, DocEntry]> = [
      ["drive-1", { name: "My Drive", documentType: "powerhouse/document-drive" }],
      ["doc-root", { name: "Root Doc", documentType: "powerhouse/document-model", driveId: "drive-1" }],
      ["doc-f1", { name: "Doc in F1", documentType: "powerhouse/document-model", driveId: "drive-1", parentFolder: "folder-1" }],
      ["doc-f2", { name: "Doc in F2", documentType: "powerhouse/document-model", driveId: "drive-1", parentFolder: "folder-2" }],
    ];

    const driveManifests = {
      "drive-1": {
        folders: {
          "folder-1": { name: "Folder One" },
          "folder-2": { name: "Folder Two" },
        },
      },
    };

    const { result } = buildTree(docs, driveManifests);
    expect(result["drive-1"].rootDocs).toEqual(["Root Doc"]);
    expect(result["drive-1"].rootFolders).toHaveLength(2);
    expect(result["drive-1"].rootFolders[0].name).toBe("Folder One");
    expect(result["drive-1"].rootFolders[0].docs).toEqual(["Doc in F1"]);
    expect(result["drive-1"].rootFolders[1].name).toBe("Folder Two");
    expect(result["drive-1"].rootFolders[1].docs).toEqual(["Doc in F2"]);
  });

  it("should handle nested folders (3 levels deep)", () => {
    const docs: Array<[string, DocEntry]> = [
      ["drive-1", { name: "My Drive", documentType: "powerhouse/document-drive" }],
      ["doc-root", { name: "Root Doc", documentType: "powerhouse/document-model", driveId: "drive-1" }],
      ["doc-in-a", { name: "Doc in A", documentType: "powerhouse/document-model", driveId: "drive-1", parentFolder: "folder-a" }],
      ["doc-in-b", { name: "Doc in B", documentType: "powerhouse/document-model", driveId: "drive-1", parentFolder: "folder-b" }],
      ["doc-in-c", { name: "Doc in C", documentType: "powerhouse/document-model", driveId: "drive-1", parentFolder: "folder-c" }],
    ];

    const driveManifests = {
      "drive-1": {
        folders: {
          "folder-a": { name: "Folder A" },                         // root
          "folder-b": { name: "Folder B", parentFolder: "folder-a" }, // nested in A
          "folder-c": { name: "Folder C", parentFolder: "folder-b" }, // nested in B (3 levels)
        },
      },
    };

    const { result } = buildTree(docs, driveManifests);

    // Root level: 1 folder + 1 doc
    expect(result["drive-1"].rootDocs).toEqual(["Root Doc"]);
    expect(result["drive-1"].rootFolders).toHaveLength(1);

    // Level 1: Folder A
    const folderA = result["drive-1"].rootFolders[0];
    expect(folderA.name).toBe("Folder A");
    expect(folderA.docs).toEqual(["Doc in A"]);
    expect(folderA.subFolders).toHaveLength(1);

    // Level 2: Folder B (inside A)
    const folderB = folderA.subFolders[0];
    expect(folderB.name).toBe("Folder B");
    expect(folderB.docs).toEqual(["Doc in B"]);
    expect(folderB.subFolders).toHaveLength(1);

    // Level 3: Folder C (inside B)
    const folderC = folderB.subFolders[0];
    expect(folderC.name).toBe("Folder C");
    expect(folderC.docs).toEqual(["Doc in C"]);
    expect(folderC.subFolders).toHaveLength(0);
  });

  it("should show docs at root when driveManifests has no folder info", () => {
    const docs: Array<[string, DocEntry]> = [
      ["drive-1", { name: "My Drive", documentType: "powerhouse/document-drive" }],
      ["doc-1", { name: "Doc A", documentType: "powerhouse/document-model", driveId: "drive-1", parentFolder: "folder-x" }],
      ["doc-2", { name: "Doc B", documentType: "powerhouse/document-model", driveId: "drive-1" }],
    ];

    // No driveManifests — Doc A has a parentFolder that doesn't exist,
    // so it's effectively orphaned within the drive (not shown at root).
    // Only Doc B (no parentFolder) appears at root.
    const { result } = buildTree(docs);
    expect(result["drive-1"].rootDocs).toEqual(["Doc B"]);
    expect(result["drive-1"].rootFolders).toHaveLength(0);
  });

  it("should match the structure from the user's test drive", () => {
    // Exact structure from the user's screenshots:
    // my drive/
    //   ├── my doc (root)
    //   ├── asdadsad/ (folder at root — actually this is a folder name)
    //   ├── first folder/
    //   │   ├── conc (doc)
    //   │   └── another folder/
    //   │       └── asdadsad (doc)
    //   └── (empty)

    const docs: Array<[string, DocEntry]> = [
      ["drive-1", { name: "my drive", documentType: "powerhouse/document-drive" }],
      ["doc-my-doc", { name: "my doc", documentType: "powerhouse/document-model", driveId: "drive-1" }],
      ["doc-conc", { name: "conc", documentType: "powerhouse/document-model", driveId: "drive-1", parentFolder: "folder-first" }],
      ["doc-asd", { name: "asdadsad", documentType: "powerhouse/document-model", driveId: "drive-1", parentFolder: "folder-another" }],
    ];

    const driveManifests = {
      "drive-1": {
        folders: {
          "folder-asd": { name: "asdadsad" },                                // root folder
          "folder-first": { name: "first folder" },                          // root folder
          "folder-another": { name: "another folder", parentFolder: "folder-first" }, // nested
        },
      },
    };

    const { result } = buildTree(docs, driveManifests);

    // Root level: 2 folders + 1 doc
    expect(result["drive-1"].rootDocs).toEqual(["my doc"]);
    expect(result["drive-1"].rootFolders).toHaveLength(2);

    // asdadsad folder (empty)
    const folderAsd = result["drive-1"].rootFolders.find(f => f.name === "asdadsad");
    expect(folderAsd).toBeDefined();
    expect(folderAsd!.docs).toHaveLength(0);
    expect(folderAsd!.subFolders).toHaveLength(0);

    // first folder with nested structure
    const folderFirst = result["drive-1"].rootFolders.find(f => f.name === "first folder");
    expect(folderFirst).toBeDefined();
    expect(folderFirst!.docs).toEqual(["conc"]);
    expect(folderFirst!.subFolders).toHaveLength(1);

    // another folder (inside first folder)
    const folderAnother = folderFirst!.subFolders[0];
    expect(folderAnother.name).toBe("another folder");
    expect(folderAnother.docs).toEqual(["asdadsad"]);
  });

  it("should handle multiple drives", () => {
    const docs: Array<[string, DocEntry]> = [
      ["drive-1", { name: "Work", documentType: "powerhouse/document-drive" }],
      ["drive-2", { name: "Personal", documentType: "powerhouse/document-drive" }],
      ["doc-1", { name: "Report", documentType: "powerhouse/document-model", driveId: "drive-1", parentFolder: "f1" }],
      ["doc-2", { name: "Notes", documentType: "powerhouse/document-model", driveId: "drive-2" }],
    ];

    const driveManifests = {
      "drive-1": { folders: { "f1": { name: "Reports" } } },
    };

    const { result } = buildTree(docs, driveManifests);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result["drive-1"].rootFolders[0].docs).toEqual(["Report"]);
    expect(result["drive-2"].rootDocs).toEqual(["Notes"]);
  });

  it("should detect orphan docs (no valid driveId)", () => {
    const docs: Array<[string, DocEntry]> = [
      ["drive-1", { name: "My Drive", documentType: "powerhouse/document-drive" }],
      ["doc-1", { name: "Linked", documentType: "powerhouse/document-model", driveId: "drive-1" }],
      ["doc-2", { name: "Orphan", documentType: "powerhouse/document-model", driveId: "deleted-drive" }],
      ["doc-3", { name: "No Drive", documentType: "powerhouse/document-model" }],
    ];

    const { result, orphans } = buildTree(docs);
    expect(result["drive-1"].rootDocs).toEqual(["Linked"]);
    expect(orphans).toEqual(["Orphan", "No Drive"]);
  });

  it("should handle parallel folders at the same level", () => {
    // The user's exact test case:
    // my drive/
    //   ├── first folder/
    //   │   ├── doc in first
    //   │   └── another folder/
    //   │       └── doc in another
    //   ├── parallel folder/
    //   │   └── doc in parallel
    //   └── root doc

    const docs: Array<[string, DocEntry]> = [
      ["drive-1", { name: "my drive", documentType: "powerhouse/document-drive" }],
      ["doc-root", { name: "root doc", documentType: "powerhouse/document-model", driveId: "drive-1" }],
      ["doc-in-first", { name: "doc in first", documentType: "powerhouse/document-model", driveId: "drive-1", parentFolder: "folder-first" }],
      ["doc-in-another", { name: "doc in another", documentType: "powerhouse/document-model", driveId: "drive-1", parentFolder: "folder-another" }],
      ["doc-in-parallel", { name: "doc in parallel", documentType: "powerhouse/document-model", driveId: "drive-1", parentFolder: "folder-parallel" }],
    ];

    const driveManifests = {
      "drive-1": {
        folders: {
          "folder-first": { name: "first folder" },
          "folder-another": { name: "another folder", parentFolder: "folder-first" },
          "folder-parallel": { name: "parallel folder" },
        },
      },
    };

    const { result } = buildTree(docs, driveManifests);

    // Root level: 2 parallel folders + 1 root doc
    expect(result["drive-1"].rootDocs).toEqual(["root doc"]);
    expect(result["drive-1"].rootFolders).toHaveLength(2);

    // first folder
    const first = result["drive-1"].rootFolders.find(f => f.name === "first folder");
    expect(first).toBeDefined();
    expect(first!.docs).toEqual(["doc in first"]);
    expect(first!.subFolders).toHaveLength(1);
    expect(first!.subFolders[0].name).toBe("another folder");
    expect(first!.subFolders[0].docs).toEqual(["doc in another"]);

    // parallel folder (sibling of first folder at root)
    const parallel = result["drive-1"].rootFolders.find(f => f.name === "parallel folder");
    expect(parallel).toBeDefined();
    expect(parallel!.docs).toEqual(["doc in parallel"]);
    expect(parallel!.subFolders).toHaveLength(0);
  });

  it("should handle empty folders correctly (show folder, no docs)", () => {
    const docs: Array<[string, DocEntry]> = [
      ["drive-1", { name: "My Drive", documentType: "powerhouse/document-drive" }],
    ];

    const driveManifests = {
      "drive-1": {
        folders: {
          "f1": { name: "Empty Folder" },
          "f2": { name: "Also Empty", parentFolder: "f1" },
        },
      },
    };

    const { result } = buildTree(docs, driveManifests);

    // renderFolder returns null for empty folders in the real UI,
    // but the tree structure should still include them
    expect(result["drive-1"].rootFolders).toHaveLength(1);
    expect(result["drive-1"].rootFolders[0].name).toBe("Empty Folder");
    expect(result["drive-1"].rootFolders[0].subFolders).toHaveLength(1);
    expect(result["drive-1"].rootFolders[0].subFolders[0].name).toBe("Also Empty");
  });
});
