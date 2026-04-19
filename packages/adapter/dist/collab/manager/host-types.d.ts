/**
 * Minimal structural types for the host's `window.ph` surface. The real
 * ReactorClient / IReactor / document-drive types live in the reactor
 * packages — this module's needs are narrow, so we declare only the
 * methods we actually call. Keeps the adapter loosely coupled to the
 * host's exact API while still staying `any`-free.
 */
import type { CollabSummary } from "../types.js";
/** Opaque reactor handles — we never construct, inspect, or dereference
 *  these; they just flow back to the host on subsequent calls. */
export type ReactorOperation = unknown;
/** Drive-shaped value returned by `reactorClient.get(driveId)`. Only
 *  the node list is used (for listDocIdsInDrive). */
export interface ReactorDriveDocument {
    state?: {
        global?: {
            nodes?: ReactorDriveNode[];
        };
    };
    header?: {
        id?: string;
        name?: string;
    };
}
export interface ReactorDriveNode {
    id?: string;
    kind?: "file" | "folder" | string;
}
/** The subset of ReactorClient methods collab-manager needs. */
export interface ReactorClientLike {
    get(driveId: string): Promise<ReactorDriveDocument>;
}
/** The subset of IReactor methods collab-manager needs. */
export interface ReactorLike {
    load(docId: string, branch: string, operations: ReactorOperation[]): Promise<unknown>;
}
/** Shape mirrored onto `window.ph` by Connect. */
export interface HostPh {
    reactorClient?: ReactorClientLike;
    reactor?: ReactorLike;
    reactorClientModule?: {
        reactorModule?: {
            reactor?: ReactorLike;
        };
    };
}
/** Global augmentation: `window.ph` is set by Connect when the app boots. */
export interface HostWindow {
    ph?: HostPh;
    localStorage?: {
        getItem(key: string): string | null;
        setItem(key: string, value: string): void;
        removeItem(key: string): void;
    };
    dispatchEvent?(event: Event): boolean;
}
/**
 * SwarmChannel publishes this on `globalThis.__swarmCollabManager__`
 * so the channel can find us without a direct import. Typed so
 * callers don't have to use `any` to install/tear down the hook.
 */
export interface CollabManagerHook {
    handleLocalPush(input: {
        driveId: string;
        docId: string;
        ops: readonly unknown[];
        scope: string;
        branch: string;
    }): Promise<void>;
    get(collabId: string): CollabSummary | undefined;
}
/**
 * Narrow `globalThis` accessor — returns the host window when present,
 * `undefined` in non-browser contexts (Node tests, SSR).
 */
export declare function hostWindow(): HostWindow | undefined;
export declare function hostPh(): HostPh | undefined;
//# sourceMappingURL=host-types.d.ts.map