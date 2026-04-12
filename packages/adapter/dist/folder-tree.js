/**
 * Recursive folder tree builder — shared between UI rendering and tests.
 *
 * Same algorithm as the Switchboard CLI's build_children():
 * 1. Find all nodes where parentFolder matches current parent (null for root)
 * 2. Folders first (recurse), then files
 * 3. Sort folders alphabetically by name
 */
export function buildFolderTree(parentId, folders, docs) {
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
    const subFolders = matchingFolders.map(([id, f]) => {
        const children = buildFolderTree(id, folders, docs);
        return { id, name: f.name, subFolders: children.subFolders, docs: children.docs };
    });
    return { subFolders, docs: matchingDocs };
}
//# sourceMappingURL=folder-tree.js.map