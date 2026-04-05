# Reactor Storage Architecture — Deep Dive

## How the Reactor Works

The Powerhouse Reactor is an **event-sourced storage node** that stores documents, resolves conflicts, reruns operations to verify histories, and syncs with other reactors via the **DocSync** protocol.

### Data Flow

```
Client Action → Job Queue → Reducer → Operation Store
                                      ↓
                           Read Model Coordinator
                                      ↓
              ┌───────────────────┬────┴──────────────────┐
    Pre-ready Read Models   Post-ready Read Models   Processors
    (DocumentView,             (ProcessorManager)     (user-defined)
     DocumentIndexer)
```

### Job Lifecycle

```
PENDING → RUNNING → WRITE_READY → READ_READY
                 ↘ FAILED
```

- `WRITE_READY` = Operations persisted to storage
- `READ_READY` = All read models (DocumentView, DocumentIndexer) updated
- `FAILED` = Unrecoverable error

## Internal Storage Tables

The Reactor uses **Kysely** (SQL abstraction) backed by **PGLite** (in-memory Postgres), with 14 migration tables:

### Core Persistence Tables

**`Operation`** — the append-only operation log
- `id, jobId, opId, prevOpId, writeTimestampUtcMs`
- `documentId, documentType, scope, branch`
- `timestampUtcMs, index, action (jsonb)`
- `skip, error, hash`
- Unique constraint: `(documentId, scope, branch, index)`
- Each `action` stored as **JSONB** (full action + input)
- `prevOpId` creates a **hash chain** (like blockchain blocks)
- **Optimistic locking**: `apply()` checks current revision before writing
- **Atomic batching**: multiple operations in one transaction

**`Keyframe`** — periodic full-state snapshots
- `id, documentId, documentType, scope, branch, revision`
- `document (jsonb)` — complete PHDocument
- `createdAt`
- Unique: `(documentId, scope, branch, revision)`
- Purpose: avoid replaying ALL operations from start
- `findNearestKeyframe(docId, scope, branch, targetRevision)` → closest snapshot ≤ target

### Projection / Cache Tables (rebuildable)

**`Document`** — metadata (`id, createdAt, updatedAt`)

**`DocumentSnapshot`** — current state per document/scope/branch
- Written by `KyselyDocumentView` read model
- Contains: `content (jsonb), lastOperationIndex, lastOperationHash`
- Deleted documents get `isDeleted = true`

**`DocumentRelationship`** — parent-child relationships between documents
- `sourceId → targetId`, with `relationshipType` and `metadata (jsonb)`

**`SlugMapping`** — slug → documentId reverse lookup

**`DocumentCollections`** / **`OperationIndex`** — collection membership and fast operation queries

**`ViewState`** — read model cursor tracking (`readModelId → lastOrdinal`)

**`ProcessorCursor`** — processor progress tracking (`processorId → lastOrdinal`)

## In-Memory Cache Layer (Above SQL)

**`KyselyWriteCache`**:
- Ring buffer per document (configurable size, default 10)
- LRU eviction tracker
- Cache hit = O(1), warm miss = O(m), cold miss = O(n)
- Persists keyframes to `Keyframe` table on eviction

**`KyselyOperationIndex`**:
- Tracks which documents are in "collections"
- Supports fast queries like "all notes in topic X"

## How State Is Rebuilt (Read Path)

```
1. Check write cache ring buffer → hit? Return cached snapshot
2. Miss? Find nearest keyframe (from Keyframe table, revision ≤ target)
3. Replay operations from keyframe revision to target revision
4. Store result in write cache (with LRU eviction)
5. Return document state
```

**Without keyframe**: Replay ALL operations from index 0
**With keyframe at rev 50, target rev 55**: Replay only ops 51-55

## Key Insight for Swarm

For the Swarm adapter, only **Operation** and **Keyframe** tables matter for persistence. Everything else (`Document`, `DocumentSnapshot`, `ViewState`, `SlugMapping`, `DocumentIndex`) can be **rebuilt** from operations + keyframes on startup.

The SQL tables stay as **local cache** — they're fast-read projections.

## Swarm Storage Mapping

### Operations → `/bytes`

```
POST /bytes { action: {...}, hash: "...", index: 9 }
→ Returns: contentHash: "f1c9a4b3..."

GET /bytes/f1c9a4b3...
→ Returns: { action, hash, index }
```

Operations are stored individually or batched:
```json
// Single operation chunk
{
  "documentId": "doc-123",
  "scope": "global",
  "branch": "main",
  "index": 9,
  "opId": "op-456",
  "hash": "sha256:...",
  "action": { "type": "SET_TITLE", "input": {"title": "Hello"} },
  "timestampUtcMs": "2026-04-05T16:00:00Z"
}

// Or batch of operations per document/scope/branch
{
  "docId": "...", "scope": "global", "branch": "main",
  "startIndex": 0, "endIndex": 9,
  "operations": [ ... ]
}
```

### Feeds — Mutable References

```
Feeds use: POST /feeds/<owner>/<topic>
Update:    PUT /feeds/<owner>/<topic>
Read:      GET /feeds/<owner>/<topic>

Each feed stores a manifest:
{
  "operationsHash": "f1c9a4b3...",    // latest ops chunk
  "keyframesHash": {"50": "c7d8e9f1...", "100": "a1b2c3d4..."},
  "latestRevision": 127,
  "documentType": "bai/knowledge-note",
  "updatedAt": "2026-04-05T16:00:00Z"
}
```

Feed update protocol:
1. Upload new ops chunk to `/bytes` → get `contentHash`
2. Read current feed → get manifest → add new keyframe entry
3. Update feed with new manifest hash

### Sync Between Reactors

DocSync already sends operations between reactors. With Swarm:
- Reactor A writes operations to Swarm
- Reactor B polls Reactor A's feed for changes
- Reactor B downloads new operations from `/bytes`
- Reactor B replays operations → rebuild local projections
- If conflict: Reactor reconciles via hash chain comparison

## Performance Considerations

| Operation | PGLite | Swarm Bee | Notes |
|---|---|---|---|
| Write single op | <1ms | 50-200ms | Bee needs postage stamp |
| Write batch (10 ops) | <5ms | 100-500ms | Batch reduces upload count |
| Read ops (100) | <1ms | 200-1000ms | Depends on chunking strategy |
| State rebuild (full) | <10ms | 1-5s | Keyframes reduce this |
| Concurrent writes | ACID | Eventual consistency | Need conflict detection |

## What Changes in the Adaptor

The adaptor implements these interfaces:

```typescript
interface IOperationStore {
  apply(docId, docType, scope, branch, revision, fn);
  readOperations(docId, scope, branch, fromIndex, toIndex);
  readLatestRevision(docId, scope, branch);
  readOperation(docId, scope, branch, index);
  deleteOperationsForTest(docId, scope, branch);
}

interface IKeyframeStore {
  putKeyframe(docId, scope, branch, revision, document);
  findNearestKeyframe(docId, scope, branch, targetRevision);
}

interface IDocumentView {
  // Rebuilt from operations + keyframes on startup
}
```
