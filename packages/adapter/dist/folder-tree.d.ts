/**
 * Recursive folder tree builder — shared between UI rendering and tests.
 *
 * Same algorithm as the Switchboard CLI's build_children():
 * 1. Find all nodes where parentFolder matches current parent (null for root)
 * 2. Folders first (recurse), then files
 * 3. Sort folders alphabetically by name
 */
export type FolderEntry = {
    name: string;
    parentFolder?: string;
};
export type DocEntry = {
    name?: string;
    documentType?: string;
    driveId?: string;
    parentFolder?: string;
};
export type TreeFolder = {
    id: string;
    name: string;
    subFolders: TreeFolder[];
    docs: Array<[string, DocEntry]>;
};
export declare function buildFolderTree(parentId: string | null, folders: Record<string, FolderEntry>, docs: Array<[string, DocEntry]>): {
    subFolders: TreeFolder[];
    docs: Array<[string, DocEntry]>;
};
//# sourceMappingURL=folder-tree.d.ts.map