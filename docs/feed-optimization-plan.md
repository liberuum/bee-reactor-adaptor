# Feed Optimization Plan — Efficient Swarm Writes for 1000s of Operations

**Date:** 2026-04-07
**Status:** Implemented (adapter 0.16.0 + plugin) — all 4 phases complete

## Context

Each document edit currently triggers a Swarm feed write (SOC) for the document manifest. Feed writes use `findNextIndex` which does exponential binary search — if the previous write hasn't propagated to the Bee node yet, `findNextIndex` returns a stale index and the SOC write fails with 400. The adapter retries 3 times with 1.5s backoff, but this fails under rapid edits.

With 1000s of ops, the current architecture produces hundreds of feed writes that compound propagation delays. The Swarm docs recommend the "regenerate and publish" pattern (used by Etherjot): batch changes, upload immutable data to `/bytes`, and update the feed **once** with a pointer.

## Solution: 4-Phase Architecture

### Current flow (per edit burst of N ops):
```
Each op → /bytes upload → doc manifest FEED WRITE → user manifest FEED WRITE
= 2N /bytes + 2 doc feed writes + 1 user feed write
```

### Target flow (per edit burst of N ops):
```
Each op → accumulate in memory
[3s debounce] → 1 /bytes (all ops) → 1 /bytes (manifest) → 1 doc FEED WRITE (72-byte ref)
[1s later]   → 1 /bytes (user manifest) → 1 user FEED WRITE (72-byte ref)
= 3 /bytes + 2 feed writes total (regardless of N)
```

For 1000 rapid edits: **3 /bytes + 2 feed writes** instead of **2000+ /bytes + 1000+ feed writes**.

---

## Phase 1: Debounced Document Manifest Writes (Plugin)
**Impact: HIGHEST — directly eliminates 400 errors**

**File:** `swarm-doc-model/processors/swarm-plugin.ts`

Split `syncDocumentToSwarm` into two stages:

**Immediate (per event):**
- Upload new ops to `/bytes` (content-addressed, fast, no conflicts)
- Update manifest object in memory (`pendingManifests` map)
- Reset 3s debounce timer for this document

**Debounced (3s after last edit):**
- Write manifest to feed via `swarmClient.updateManifest()`
- Update user manifest (existing 1s debounce)
- Save manifest index to IndexedDB

Key design:
```typescript
const pendingManifests = new Map<string, any>(); // docId → manifest
const manifestWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DOCUMENT_MANIFEST_FLUSH_DELAY_MS = 3000;
```

1. `syncDocumentToSwarm`: after uploading ops, store manifest in `pendingManifests` instead of writing to feed
2. New `flushDocumentManifest(docId)`: takes manifest from map, writes to feed
3. Manifest reads check `pendingManifests` cache first (avoid stale feed reads)
4. `beforeunload` handler flushes pending manifests

---

## Phase 2: Manifest-as-Reference (Adapter)
**Impact: MEDIUM — smaller/faster feed writes, enables future optimizations**

**File:** `bee-reactor-adaptor/src/swarm-client.ts`

Instead of writing full manifest JSON to feed, upload to `/bytes` first and write only the 64-char reference.

**bee-js already has `FeedWriter.uploadReference(batchId, reference)`** which writes exactly 72 bytes (8-byte timestamp + 64-byte ref) to the SOC. This is the Etherjot pattern built into bee-js.

Changes:
1. `updateManifestViaFeed`: upload manifest JSON to `/bytes` → call `writer.uploadReference(batchId, ref)` instead of `writer.uploadPayload(batchId, data)`
2. `readManifestFromFeed`: auto-detect format — if payload starts with `{` it's old inline JSON; if it's a 64-char hex string, dereference from `/bytes`
3. Apply same pattern to `updateUserManifest` / `readUserManifest`

Backward compatible: old feeds readable by new code; next write upgrades to new format.

---

## Phase 3: Op Batch Accumulation (Plugin)
**Impact: MEDIUM — fewer manifest entries, faster recovery**
**Depends on Phase 1**

**File:** `swarm-doc-model/processors/swarm-plugin.ts`

Instead of uploading ops to `/bytes` immediately per sync, accumulate in memory:

```typescript
const pendingOps = new Map<string, Array<{index: number, action: unknown}>>();
```

1. `syncDocumentToSwarm`: add new ops to `pendingOps` buffer (no `/bytes` upload yet)
2. `flushDocumentManifest`: upload ALL accumulated ops as ONE `/bytes` batch, add ONE entry to manifest

Result: 50 rapid edits → 1 `/bytes` upload, 1 batch entry (not 2+). Manifest grows slowly.

---

## Phase 4: Manifest Compaction (Adapter)
**Impact: LOW — optimization for long-running deployments**
**Independent of other phases**

**File:** `bee-reactor-adaptor/src/swarm-client.ts`

New method `compactManifest(docId, maxBatches=20)`:
1. If manifest has ≤maxBatches entries, skip
2. Download all batches, merge/dedup ops, upload as 1 batch
3. Write compacted manifest

Called from plugin on startup or periodically. Old batches expire with stamp TTL.

---

## Implementation Order

```
Phase 1 (Plugin: debounce)    ← Do first, highest impact
    └─→ Phase 3 (Plugin: op accumulation)  ← Extends Phase 1
Phase 2 (Adapter: manifest-as-ref) ← Independent, can parallel with Phase 1
Phase 4 (Adapter: compaction) ← Lowest priority, do last
```

## Swarm Architecture Principles (from official docs)

1. **Feeds are mutable pointers on immutable storage** — minimize feed writes, maximize `/bytes` uploads
2. **"Regenerate and publish" pattern** — batch changes, upload complete structure, update feed once (Etherjot pattern)
3. **Feed entries should be pointers** — small SOC (72 bytes) pointing to content-addressed data
4. **Always use immutable batches** — mutable batches corrupt feed indexing
5. **Per-topic serialization** — one writer per feed topic, prevent concurrent `findNextIndex` conflicts

## Verification

1. **Phase 1**: Create doc, make 20 rapid edits, verify only 1 "Synced" log (after 3s), no 400 errors
2. **Phase 2**: Sync a doc, read manifest, verify round-trip. Check old-format feeds still readable
3. **Phase 3**: Make 50 rapid edits, verify 1 batch entry in manifest (not 2+)
4. **Phase 4**: Create 30 small batches, run compaction, verify 1 batch. Test recovery
5. **End-to-end**: Create drive + doc, make 100 edits, clear browser, recover — all ops restored
