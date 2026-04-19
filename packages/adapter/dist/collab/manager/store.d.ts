/**
 * SummaryStore — owns the in-memory map of live collab summaries plus
 * its localStorage persistence, and the per-(collab, peer, doc) feed
 * cursor storage that tracks how far we've ingested each peer's ops.
 *
 * Everything else in the manager reads/writes via this store so
 * persistence is centralized and we avoid scattered `JSON.parse`
 * calls on localStorage.
 */
import type { CollabActivityEntry, CollabId, CollabSummary } from "../types.js";
/**
 * Append a CollabActivityEntry to the bounded ring-buffer, trimming
 * the front when we exceed RECENT_ACTIVITY_MAX. Returns a fresh array
 * so callers can spread into an immutable summary update.
 */
export declare function pushActivity(existing: CollabActivityEntry[] | undefined, entry: CollabActivityEntry): CollabActivityEntry[];
export declare class SummaryStore {
    private readonly summaries;
    constructor();
    get size(): number;
    has(id: CollabId): boolean;
    get(id: CollabId): CollabSummary | undefined;
    values(): IterableIterator<CollabSummary>;
    /**
     * Return summaries sorted by most-recent activity first — matches the
     * ordering the UI expects. Used by the public `list()` API.
     */
    listByRecentActivity(): CollabSummary[];
    set(id: CollabId, summary: CollabSummary): void;
    /**
     * In-place bulk load — used by the rehydrator when seeding summaries
     * from the user manifest. Bypasses a single persist() call; the
     * caller triggers persist() once after the batch finishes.
     */
    setBulk(entries: Iterable<[CollabId, CollabSummary]>): void;
    delete(id: CollabId): boolean;
    /**
     * Persist the current snapshot immediately. Callers who ran a batch
     * mutation via `setBulk` use this to flush the batch.
     */
    persist(): void;
    readCursor(collabId: CollabId, writer: string, docId: string): number;
    writeCursor(collabId: CollabId, writer: string, docId: string, value: number): void;
    private loadFromStorage;
}
//# sourceMappingURL=store.d.ts.map