/**
 * SummaryStore — owns the in-memory map of live collab summaries plus
 * its localStorage persistence, and the per-(collab, peer, doc) feed
 * cursor storage that tracks how far we've ingested each peer's ops.
 *
 * Everything else in the manager reads/writes via this store so
 * persistence is centralized and we avoid scattered `JSON.parse`
 * calls on localStorage.
 */
import { RECENT_ACTIVITY_MAX } from "../types.js";
import { LS_PEER_CURSOR_PREFIX, LS_SUMMARIES_KEY } from "./constants.js";
import { hostWindow } from "./host-types.js";
/**
 * Append a CollabActivityEntry to the bounded ring-buffer, trimming
 * the front when we exceed RECENT_ACTIVITY_MAX. Returns a fresh array
 * so callers can spread into an immutable summary update.
 */
export function pushActivity(existing, entry) {
    const prev = existing ?? [];
    if (prev.length >= RECENT_ACTIVITY_MAX) {
        return [...prev.slice(prev.length - RECENT_ACTIVITY_MAX + 1), entry];
    }
    return [...prev, entry];
}
export class SummaryStore {
    summaries = new Map();
    constructor() {
        this.loadFromStorage();
    }
    get size() {
        return this.summaries.size;
    }
    has(id) {
        return this.summaries.has(id);
    }
    get(id) {
        return this.summaries.get(id);
    }
    values() {
        return this.summaries.values();
    }
    /**
     * Return summaries sorted by most-recent activity first — matches the
     * ordering the UI expects. Used by the public `list()` API.
     */
    listByRecentActivity() {
        return Array.from(this.summaries.values()).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    }
    set(id, summary) {
        this.summaries.set(id, summary);
        this.persist();
    }
    /**
     * In-place bulk load — used by the rehydrator when seeding summaries
     * from the user manifest. Bypasses a single persist() call; the
     * caller triggers persist() once after the batch finishes.
     */
    setBulk(entries) {
        for (const [id, s] of entries) {
            this.summaries.set(id, s);
        }
    }
    delete(id) {
        const existed = this.summaries.delete(id);
        if (existed)
            this.persist();
        return existed;
    }
    /**
     * Persist the current snapshot immediately. Callers who ran a batch
     * mutation via `setBulk` use this to flush the batch.
     */
    persist() {
        try {
            const raw = JSON.stringify(Array.from(this.summaries.values()));
            hostWindow()?.localStorage?.setItem(LS_SUMMARIES_KEY, raw);
        }
        catch {
            /* localStorage unavailable */
        }
    }
    // ─── Per-(collab, writer, doc) feed cursor ────────────────────────
    readCursor(collabId, writer, docId) {
        try {
            const raw = hostWindow()?.localStorage?.getItem(cursorKey(collabId, writer, docId));
            const n = raw ? parseInt(raw, 10) : 0;
            return Number.isFinite(n) && n >= 0 ? n : 0;
        }
        catch {
            return 0;
        }
    }
    writeCursor(collabId, writer, docId, value) {
        try {
            hostWindow()?.localStorage?.setItem(cursorKey(collabId, writer, docId), String(value));
        }
        catch {
            /* localStorage unavailable */
        }
    }
    loadFromStorage() {
        try {
            const raw = hostWindow()?.localStorage?.getItem(LS_SUMMARIES_KEY);
            if (!raw)
                return;
            const list = JSON.parse(raw);
            for (const s of list)
                this.summaries.set(s.collabId, s);
        }
        catch {
            /* ignore — corrupt or unavailable */
        }
    }
}
function cursorKey(collabId, writer, docId) {
    return `${LS_PEER_CURSOR_PREFIX}${collabId}:${writer}:${docId}`;
}
//# sourceMappingURL=store.js.map