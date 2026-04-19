/**
 * SummaryStore — owns the in-memory map of live collab summaries plus
 * its localStorage persistence, and the per-(collab, peer, doc) feed
 * cursor storage that tracks how far we've ingested each peer's ops.
 *
 * Everything else in the manager reads/writes via this store so
 * persistence is centralized and we avoid scattered `JSON.parse`
 * calls on localStorage.
 */

import type {
  CollabActivityEntry,
  CollabId,
  CollabSummary,
} from "../types.js";
import { RECENT_ACTIVITY_MAX } from "../types.js";
import { LS_PEER_CURSOR_PREFIX, LS_SUMMARIES_KEY } from "./constants.js";
import { hostWindow } from "./host-types.js";

/**
 * Append a CollabActivityEntry to the bounded ring-buffer, trimming
 * the front when we exceed RECENT_ACTIVITY_MAX. Returns a fresh array
 * so callers can spread into an immutable summary update.
 */
export function pushActivity(
  existing: CollabActivityEntry[] | undefined,
  entry: CollabActivityEntry,
): CollabActivityEntry[] {
  const prev = existing ?? [];
  if (prev.length >= RECENT_ACTIVITY_MAX) {
    return [...prev.slice(prev.length - RECENT_ACTIVITY_MAX + 1), entry];
  }
  return [...prev, entry];
}

export class SummaryStore {
  private readonly summaries = new Map<CollabId, CollabSummary>();

  constructor() {
    this.loadFromStorage();
  }

  get size(): number {
    return this.summaries.size;
  }

  has(id: CollabId): boolean {
    return this.summaries.has(id);
  }

  get(id: CollabId): CollabSummary | undefined {
    return this.summaries.get(id);
  }

  values(): IterableIterator<CollabSummary> {
    return this.summaries.values();
  }

  /**
   * Return summaries sorted by most-recent activity first — matches the
   * ordering the UI expects. Used by the public `list()` API.
   */
  listByRecentActivity(): CollabSummary[] {
    return Array.from(this.summaries.values()).sort((a, b) =>
      b.lastActivityAt.localeCompare(a.lastActivityAt),
    );
  }

  set(id: CollabId, summary: CollabSummary): void {
    this.summaries.set(id, summary);
    this.persist();
  }

  /**
   * In-place bulk load — used by the rehydrator when seeding summaries
   * from the user manifest. Bypasses a single persist() call; the
   * caller triggers persist() once after the batch finishes.
   */
  setBulk(entries: Iterable<[CollabId, CollabSummary]>): void {
    for (const [id, s] of entries) {
      this.summaries.set(id, s);
    }
  }

  delete(id: CollabId): boolean {
    const existed = this.summaries.delete(id);
    if (existed) this.persist();
    return existed;
  }

  /**
   * Persist the current snapshot immediately. Callers who ran a batch
   * mutation via `setBulk` use this to flush the batch.
   */
  persist(): void {
    try {
      const raw = JSON.stringify(Array.from(this.summaries.values()));
      hostWindow()?.localStorage?.setItem(LS_SUMMARIES_KEY, raw);
    } catch {
      /* localStorage unavailable */
    }
  }

  // ─── Per-(collab, writer, doc) feed cursor ────────────────────────

  readCursor(collabId: CollabId, writer: string, docId: string): number {
    try {
      const raw = hostWindow()?.localStorage?.getItem(
        cursorKey(collabId, writer, docId),
      );
      const n = raw ? parseInt(raw, 10) : 0;
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  writeCursor(
    collabId: CollabId,
    writer: string,
    docId: string,
    value: number,
  ): void {
    try {
      hostWindow()?.localStorage?.setItem(
        cursorKey(collabId, writer, docId),
        String(value),
      );
    } catch {
      /* localStorage unavailable */
    }
  }

  private loadFromStorage(): void {
    try {
      const raw = hostWindow()?.localStorage?.getItem(LS_SUMMARIES_KEY);
      if (!raw) return;
      const list = JSON.parse(raw) as CollabSummary[];
      for (const s of list) this.summaries.set(s.collabId, s);
    } catch {
      /* ignore — corrupt or unavailable */
    }
  }
}

function cursorKey(collabId: CollabId, writer: string, docId: string): string {
  return `${LS_PEER_CURSOR_PREFIX}${collabId}:${writer}:${docId}`;
}
