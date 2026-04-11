/**
 * Recursive folder tree builder — shared between UI rendering and tests.
 *
 * Same algorithm as the Switchboard CLI's build_children():
 * 1. Find all nodes where parentFolder matches current parent (null for root)
 * 2. Folders first (recurse), then files
 * 3. Sort folders alphabetically by name
 */

export type FolderEntry = { name: string; parentFolder?: string };
export type DocEntry = { name?: string; documentType?: string; driveId?: string; parentFolder?: string };

export type TreeFolder = {
  id: string;
  name: string;
  subFolders: TreeFolder[];
  docs: Array<[string, DocEntry]>;
};

export function buildFolderTree(
  parentId: string | null,
  folders: Record<string, FolderEntry>,
  docs: Array<[string, DocEntry]>,
): { subFolders: TreeFolder[]; docs: Array<[string, DocEntry]> } {
  const matchingFolders = Object.entries(folders)
    .filter(([, f]) => {
      const parent = f.parentFolder || null;
      return parent === parentId;
    })
    .sort(([, a], [, b]) => (a.name ?? "").localeCompare(b.name ?? ""));

  const matchingDocs = docs.filter(([, d]) => {
    const parent = d.parentFolder || null;
    return parent === parentId;
  });

  const subFolders: TreeFolder[] = matchingFolders.map(([id, f]) => {
    const children = buildFolderTree(id, folders, docs);
    return { id, name: f.name, subFolders: children.subFolders, docs: children.docs };
  });

  return { subFolders, docs: matchingDocs };
}
