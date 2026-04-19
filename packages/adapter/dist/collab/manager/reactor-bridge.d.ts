/**
 * Thin accessors for the reactor APIs the collab manager needs from the
 * host window (Connect). Keeps the `globalThis.window.ph` plumbing in
 * one place so the rest of the manager reads cleanly.
 */
import { type ReactorClientLike, type ReactorLike } from "./host-types.js";
/**
 * Get the host's ReactorClient — exposes `.get` for reads. Returns
 * `undefined` when Connect hasn't wired up `window.ph.reactorClient`
 * yet (cold boot, tests).
 */
export declare function getReactorClient(): ReactorClientLike | undefined;
/**
 * Get the lower-level IReactor — exposes `.load(docId, branch, ops)`
 * for sync-style writes of bare operations. Falls back to a legacy
 * `window.ph.reactor` shim when the new module path is absent.
 */
export declare function getReactor(): ReactorLike | undefined;
/**
 * Resolve the file-kind nodes under a drive via the reactor client.
 * Returns `[]` when the reactor isn't available or the drive can't be
 * read — callers treat an empty list as "nothing to poll / mirror".
 */
export declare function listDocIdsInDrive(driveId: string): Promise<string[]>;
/**
 * Best-effort `window.dispatchEvent` — no-op in non-browser contexts so
 * the manager can be tested in plain Node.
 */
export declare function dispatchWindowEvent(name: string, detail: unknown): void;
//# sourceMappingURL=reactor-bridge.d.ts.map