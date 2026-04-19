/**
 * Thin accessors for the reactor APIs the collab manager needs from the
 * host window (Connect). Keeps the `globalThis.window.ph` plumbing in
 * one place so the rest of the manager reads cleanly.
 */

import {
  hostPh,
  hostWindow,
  type ReactorClientLike,
  type ReactorLike,
} from "./host-types.js";

/**
 * Get the host's ReactorClient — exposes `.get` for reads. Returns
 * `undefined` when Connect hasn't wired up `window.ph.reactorClient`
 * yet (cold boot, tests).
 */
export function getReactorClient(): ReactorClientLike | undefined {
  return hostPh()?.reactorClient;
}

/**
 * Get the lower-level IReactor — exposes `.load(docId, branch, ops)`
 * for sync-style writes of bare operations. Falls back to a legacy
 * `window.ph.reactor` shim when the new module path is absent.
 */
export function getReactor(): ReactorLike | undefined {
  const ph = hostPh();
  return ph?.reactorClientModule?.reactorModule?.reactor ?? ph?.reactor;
}

/**
 * Resolve the file-kind nodes under a drive via the reactor client.
 * Returns `[]` when the reactor isn't available or the drive can't be
 * read — callers treat an empty list as "nothing to poll / mirror".
 */
export async function listDocIdsInDrive(driveId: string): Promise<string[]> {
  const reactorClient = getReactorClient();
  if (!reactorClient) return [];
  try {
    const drive = await reactorClient.get(driveId);
    const nodes = drive?.state?.global?.nodes ?? [];
    return nodes
      .filter((n): n is { id: string; kind: string } =>
        n?.kind === "file" && typeof n?.id === "string",
      )
      .map((n) => n.id);
  } catch {
    return [];
  }
}

/**
 * Best-effort `window.dispatchEvent` — no-op in non-browser contexts so
 * the manager can be tested in plain Node.
 */
export function dispatchWindowEvent(name: string, detail: unknown): void {
  try {
    const w = hostWindow();
    w?.dispatchEvent?.(new CustomEvent(name, { detail }));
  } catch {
    /* non-browser */
  }
}
