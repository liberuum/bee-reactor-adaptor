/**
 * Shared mutable state for the Swarm plugin system.
 *
 * All cross-module state lives here so every module can read/write it
 * without circular imports. Status helpers and small utilities included.
 */
import type { SwarmDriveManifest } from "../types.js";
export { createEmptyManifest } from "../types.js";
/**
 * Minimal interface for the Connect reactor client.
 *
 * The actual ReactorClient from @powerhousedao/reactor has a richer API,
 * but these are the methods the plugin modules use. Return types are `any`
 * because the reactor's response shapes vary by document type and version.
 */
export interface ReactorClient {
    get(documentId: string): Promise<any>;
    getDrives(): Promise<any[]>;
    getChildren(driveId: string): Promise<any>;
    getOperations(documentId: string): Promise<any>;
    execute(documentId: string, branch: string, actions: any[]): Promise<any>;
    createDocumentInDrive(driveId: string, doc: any): Promise<any>;
    getDocumentModelModule?(documentType: string): Promise<any>;
    subscribe?(filter: Record<string, unknown>, handler: (event: any) => void): (() => void) | undefined;
}
export declare function persistBeeUrl(url: string): void;
export declare const state: {
    /** Bee node URL (mutable — changed via settings UI) */
    beeUrl: string;
    docToDrive: Map<string, string>;
    driveNames: Map<string, string>;
    driveManifestCache: Map<string, SwarmDriveManifest>;
    /** local drive ID → Swarm drive ID (set during hydration) */
    localToSwarmDrive: Map<string, string>;
    /** Swarm drive ID → local drive ID (set during hydration) */
    swarmToLocalDrive: Map<string, string>;
};
/** Load drive mapping from localStorage into state */
export declare function loadDriveMapping(): void;
/** Update the swarm status on window.ph.swarm for the settings UI */
export declare function setSwarmStatus(status: string, message?: string): void;
/** Track total bytes uploaded to Swarm (persists in sessionStorage for display) */
export declare function getUploadedBytes(): number;
//# sourceMappingURL=state.d.ts.map