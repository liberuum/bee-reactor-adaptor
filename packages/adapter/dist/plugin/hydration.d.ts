import { type ReactorClient } from "./state.js";
/**
 * Restore folder structure in a local drive from a folder/doc mapping.
 * Sorts folders topologically (parents first), then moves docs into folders.
 * Used by both hydration and import.
 */
export declare function restoreFolderStructure(reactorClient: ReactorClient, driveId: string, folders: Record<string, {
    name: string;
    parentFolder?: string;
}>, docMoves: Array<{
    docId: string;
    targetFolder: string;
}>): Promise<void>;
/**
 * Populate ph.swarm.userManifest.documents from drive manifest feeds.
 * Called on every manifest load (not just recovery) so the Settings UI
 * tree view always has data — even when hydration is skipped.
 */
export declare function populateUiCacheFromDrives(userManifest: {
    drives?: Record<string, any>;
    documents?: Record<string, any>;
}): Promise<void>;
//# sourceMappingURL=hydration.d.ts.map