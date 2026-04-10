/**
 * IndexedDB persistence for pending operations.
 *
 * Pending ops are buffered in memory (state.pendingOps) with a 3-second
 * debounce before uploading to Swarm. If the tab closes or the Bee node
 * is unreachable, in-memory ops would be lost.
 *
 * This module persists pending ops to IndexedDB on every buffer, and
 * removes them on successful flush. On next session startup, any
 * surviving entries are replayed into the in-memory buffer.
 */

const DB_NAME = "swarmPendingOps";
const STORE_NAME = "ops";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Persist pending ops for a document to IndexedDB.
 * Called every time ops are buffered in syncDocumentToSwarm.
 */
export async function savePendingOps(
  docId: string,
  ops: Array<{ index: number; action: unknown; hash?: string; timestampUtcMs?: string; id?: string }>,
): Promise<void> {
  try {
    const db = await openDB();
    await idbWrite(db, (store) => store.put(ops, docId));
  } catch {
    // Non-critical — worst case we lose ops on tab close (same as before this feature)
  }
}

/**
 * Remove persisted pending ops for a document after successful flush.
 */
export async function clearPendingOps(docId: string): Promise<void> {
  try {
    const db = await openDB();
    await idbWrite(db, (store) => store.delete(docId));
  } catch {
    // Non-critical
  }
}

/**
 * Remove all persisted pending ops (called on clearSwarmStorage).
 */
export async function clearAllPendingOps(): Promise<void> {
  try {
    const db = await openDB();
    await idbWrite(db, (store) => store.clear());
  } catch {
    // Non-critical
  }
}

/** Await a readwrite transaction commit before closing the DB */
function idbWrite(db: IDBDatabase, fn: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    fn(tx.objectStore(STORE_NAME));
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Load all persisted pending ops from IndexedDB.
 * Returns a map of docId → ops[]. Used on startup to replay buffered ops
 * that were never flushed (tab closed, Bee node was down, etc.).
 */
export async function loadAllPendingOps(): Promise<Map<string, Array<{ index: number; action: unknown; hash?: string; timestampUtcMs?: string; id?: string }>>> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      const result = new Map<string, Array<{ index: number; action: unknown }>>();

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          result.set(cursor.key as string, cursor.value);
          cursor.continue();
        } else {
          db.close();
          resolve(result);
        }
      };
      req.onerror = () => {
        db.close();
        resolve(new Map());
      };
    });
  } catch {
    return new Map();
  }
}

/**
 * Synchronous marker in localStorage — set on beforeunload if pending ops exist.
 * Checked on next startup to trigger replay.
 * Namespaced by owner address to prevent cross-user replay in shared browsers.
 */
const PENDING_FLAG_PREFIX = "__swarm_pending_ops__";

function flagKey(ownerAddress?: string): string {
  const addr = ownerAddress?.toLowerCase() ?? "unknown";
  return `${PENDING_FLAG_PREFIX}${addr}`;
}

export function markPendingOpsExist(ownerAddress?: string): void {
  try { localStorage.setItem(flagKey(ownerAddress), "1"); } catch {}
}

export function clearPendingOpsFlag(ownerAddress?: string): void {
  try { localStorage.removeItem(flagKey(ownerAddress)); } catch {}
}

export function hasPendingOpsFlag(ownerAddress?: string): boolean {
  try { return localStorage.getItem(flagKey(ownerAddress)) === "1"; } catch { return false; }
}
