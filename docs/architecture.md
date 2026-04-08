# How Connect + Swarm Integration Works

This document explains the plumbing: how Powerhouse Connect documents get encrypted, uploaded to the Swarm decentralized network, and restored on any device from just a wallet signature.

## The Big Picture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Connect (Browser)                                                       │
│                                                                           │
│  User edits a document                                                   │
│       ↓                                                                   │
│  Reactor processes the edit as an Operation (append-only event log)       │
│       ↓                                                                   │
│  PGlite (local Postgres in WASM) stores the operation                    │
│       ↓                                                                   │
│  swarm-plugin.ts receives the change event                               │
│       ↓                                                                   │
│  Buffers the operation in memory (pendingOps map)                        │
│       ↓  (3-second debounce)                                              │
│  Flushes: encrypt → upload to Swarm /bytes → update feed                 │
│                                                                           │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │
                       ┌───────────▼───────────┐
                       │  Bee Node (localhost)  │
                       │  /bytes  → immutable   │
                       │  /feeds  → mutable     │
                       └───────────┬───────────┘
                                   │
                       ┌───────────▼───────────┐
                       │  Swarm Network         │
                       │  (decentralized p2p)   │
                       └───────────────────────┘
```

## Key Concepts

### Operations, Not State

Powerhouse stores documents as an **append-only log of operations**, not as snapshots of state. Each edit (add a row, change a title, move an item) becomes an Operation with an index, timestamp, and hash.

To get the current document state, you replay all operations through the document model's reducer (a pure function). Same operations in same order = same state, always.

This is what makes Swarm sync possible: we upload the operations, and any device can reconstruct the full document by replaying them.

### Feeds and /bytes

Swarm has two storage primitives:

- **`/bytes`** — immutable, content-addressed. Upload data, get back a hash. Same data = same hash. Can never change.
- **Feeds** — mutable pointers. A feed is identified by (topic, owner address). The owner can update what it points to. Anyone can read it.

We use `/bytes` for the actual data (encrypted operations) and feeds as mutable pointers to the latest data.

### Encryption

All data is encrypted with AES-256-GCM **before** it leaves the browser. The Bee node never sees plaintext.

```
Key derivation (deterministic — same wallet = same key on any device):
  1. User connects MetaMask
  2. Signs a domain-specific message via personal_sign
  3. keccak256(signature) → 32-byte secp256k1 private key
  4. SHA-256(private_key) → AES-256 encryption key

Encryption format:
  [SWE prefix (3 bytes)] [IV (12 bytes)] [AES-256-GCM ciphertext + auth tag]

The SWE prefix (0x535745) marks encrypted data. Old unencrypted data
is detected by its absence — backward compatible.
```

---

## The Three Layers

### Layer 1: bee-reactor-adapter (npm package)

The `SwarmClient` class wraps the Bee SDK and provides:

| Method | What it does |
|--------|-------------|
| `uploadData(data)` | Encrypt + upload to /bytes → returns content hash |
| `downloadData(ref)` | Download from /bytes + auto-decrypt if SWE prefix detected |
| `updateManifest(docId, manifest)` | Upload manifest JSON to /bytes, write hash to feed |
| `readManifest(docId)` | Read feed → dereference hash → download + decrypt manifest |
| `updateUserManifest(address, manifest)` | Same pattern for the user-level index |
| `readUserManifest(address)` | Read user's document index from their feed |
| `getStampStatus()` | Postage stamp health, capacity, cost |
| `grantAccess() / revokeAccess()` | ACT encryption for sharing (planned) |

The client also handles:
- **Per-topic write locks** — prevents concurrent feed writes from getting the same index
- **3-retry with backoff** — handles Swarm propagation delays on feed writes
- **Auto-detect feed format** — legacy inline JSON vs new reference format

### Layer 2: swarm-plugin.ts (processor in swarm-doc-model)

This is the glue between Connect's reactor and the SwarmClient. It runs as a processor in the browser.

**On startup:**
1. Checks Bee node health (`/health`)
2. Finds a usable postage stamp (`/stamps`)
3. Imports `SwarmConnectPlugin` from the adapter
4. Triggers wallet signature → derives Swarm key (or loads from IndexedDB cache)
5. Reads user manifest from Swarm → discovers existing documents
6. If documents exist that aren't local → runs recovery (hydration)
7. Subscribes to ALL reactor document change events

**On document edit:**
1. Reactor fires a change event with the new operation(s)
2. Plugin checks if we've already synced this operation (via `syncedRevisions` map)
3. New ops are buffered in `pendingOps` map (per document)
4. Document manifest is updated in memory (`pendingManifests` map)
5. A 3-second debounce timer is set for this document

**On debounce flush (3s after last edit for this document):**
1. ALL buffered ops for the document are uploaded as ONE `/bytes` batch
2. The document manifest (listing all operation batches) is uploaded to `/bytes`
3. Only the 64-char hash reference is written to the feed (72-byte SOC)
4. The user manifest is scheduled for update (another 3s debounce)

This means 50 rapid edits → 1 upload + 1 feed write, not 50 of each.

### Layer 3: Connect Settings UI (swarm-storage.tsx)

The settings panel in Connect that shows:
- Connection status and Bee node health
- Storage capacity, TTL, and utilization
- Document tree with per-doc sync status badges
- Stamp management (extend, expand, create new)
- Clear storage and reconnect controls

---

## Data Model on Swarm

### Per-Document: Document Manifest

Each document has a feed at topic `ph:v2:doc:<documentId>`. The feed points to a manifest:

```json
{
  "documentId": "abc-123",
  "documentType": "powerhouse/budget-statement",
  "latestRevision": { "global": 47 },
  "operationBatches": [
    {
      "reference": "a1b2c3d4...",
      "scope": "global",
      "branch": "main",
      "startIndex": 0,
      "endIndex": 23,
      "timestamp": "2026-04-07T10:00:00Z"
    },
    {
      "reference": "e5f6a7b8...",
      "scope": "global",
      "branch": "main",
      "startIndex": 24,
      "endIndex": 47,
      "timestamp": "2026-04-07T10:05:00Z"
    }
  ],
  "encrypted": true,
  "updatedAt": "2026-04-07T10:05:00Z"
}
```

Each `reference` points to a `/bytes` upload containing the encrypted operation batch.

### Per-User: User Manifest

Each user has a feed at topic `ph:v2:user:<eth_address>`. It indexes all their documents:

```json
{
  "address": "0x1234...",
  "beeNodePublicKey": "02abc...",
  "documents": {
    "drive-xyz": {
      "documentType": "powerhouse/document-drive",
      "name": "My Finance Drive",
      "driveId": "drive-xyz",
      "lastUpdated": "2026-04-07T10:05:00Z"
    },
    "abc-123": {
      "documentType": "powerhouse/budget-statement",
      "name": "Q1 Budget",
      "driveId": "drive-xyz",
      "lastUpdated": "2026-04-07T10:05:00Z"
    }
  },
  "drives": {
    "drive-xyz": {
      "name": "My Finance Drive",
      "documentIds": ["abc-123"],
      "lastUpdated": "2026-04-07T10:05:00Z"
    }
  },
  "updatedAt": "2026-04-07T10:05:00Z"
}
```

### Feed Write Pattern: Manifest-as-Reference

Instead of writing the full manifest JSON into the feed (which can be large and slow), we use the "regenerate and publish" pattern:

```
1. Serialize manifest → JSON string
2. Encrypt with AES-256-GCM → encrypted bytes
3. Upload to /bytes → get 64-char content hash
4. Write ONLY the hash to the feed → 72-byte SOC (8-byte timestamp + 64-byte reference)
```

Reading reverses this: read feed → get hash → download from /bytes → decrypt → parse JSON.

Old feeds that contain inline JSON (pre-optimization) are auto-detected and still readable.

---

## Recovery Flow (Swarm → Browser)

When a user opens Connect on a new device (or after clearing browser data):

```
1. User connects wallet (MetaMask)
2. Plugin requests personal_sign → derives the SAME Swarm key as before
3. Read user manifest from feed: ph:v2:user:<address>
4. Compare documents in manifest vs documents in local PGlite
5. For each document that exists on Swarm but NOT locally:

   a. Group documents by driveId
   b. Create a local drive for each unique driveId (with correct name)
   c. For each document in the drive:
      - Read document manifest from feed: ph:v2:doc:<docId>
      - Download each operation batch from /bytes (auto-decrypted)
      - Get the document model's default state via reactorClient.getDocumentModelModule(type)
      - Create a shell document in the local drive
      - Replay all operations via reactorClient.execute(docId, "main", ops)
      - Mark as synced in syncedRevisions map

6. Write a clean user manifest (only recovered docs, no stale entries)
7. Resume normal sync (subscribe to change events)
```

Key details:
- **`hydrationRan`** is stored in `sessionStorage` to survive Vite HMR resets
- **`recoveringDocs`** set prevents the plugin from re-uploading ops it just downloaded
- **`manifestFlushGeneration`** counter prevents stale debounced flushes from overwriting clean state
- **`syncPaused`** stays true during the entire recovery to prevent race conditions

---

## Optimization: Debounced Writes

The plugin uses three levels of debouncing to minimize Swarm feed writes:

### 1. Operation Buffering (per document)
```
Edit 1 → buffer in pendingOps["doc-123"]
Edit 2 → buffer in pendingOps["doc-123"]  (100ms later)
Edit 3 → buffer in pendingOps["doc-123"]  (200ms later)
...
[3s after last edit] → flush ALL buffered ops as ONE /bytes upload
```

### 2. Document Manifest Debounce (3s per document)
```
Each flush → update pendingManifests["doc-123"] in memory
Reset 3s timer
[3s after last flush] → upload manifest to /bytes → write ref to feed
```

### 3. User Manifest Debounce (3s global)
```
Each document manifest flush → schedule user manifest update
[3s after last doc flush] → upload user manifest to /bytes → write ref to feed
```

For a burst of 100 edits across 3 documents:
- **Without optimization**: 100 /bytes + 100 doc feed writes + 100 user feed writes = 300 Swarm operations
- **With optimization**: 3 /bytes (op batches) + 3 /bytes (manifests) + 3 doc feed writes + 1 user manifest + 1 user feed write = 11 Swarm operations

---

## Drive-Document Relationship

Connect organizes documents into drives. On Swarm, we need to preserve this structure.

**The challenge**: The reactor's `getChildren(driveId)` and `state.global.nodes` APIs are unreliable for determining which drive a document belongs to (timing issues with `JOB_WRITE_READY`).

**The solution**: `lastSeenDriveId` — a module-level variable that tracks the most recent drive ID seen by the subscriber. When a drive event fires (drive creation, rename), we store its ID. When a document flush happens, we use this as a fallback for drive resolution.

The `docToDrive` map tracks confirmed drive→doc relationships. The user manifest stores `driveId` on each document entry for recovery.

---

## Module-Level State in swarm-plugin.ts

The plugin maintains several maps and flags at module scope (persisted across function calls within the same browser session):

| State | Type | Purpose |
|-------|------|---------|
| `syncedRevisions` | `Map<string, number>` | Last synced op index per document — prevents re-uploading |
| `docToDrive` | `Map<string, string>` | Confirmed document → drive relationships |
| `pendingManifests` | `Map<string, manifest>` | In-memory manifests waiting for debounce flush |
| `pendingOps` | `Map<string, ops[]>` | Buffered operations waiting for batch upload |
| `docManifestTimers` | `Map<string, timeout>` | Active debounce timers per document |
| `lastSeenDriveId` | `string` | Most recent drive ID from subscriber events |
| `syncPaused` | `boolean` | Pauses all sync during recovery |
| `hydrationRan` | `boolean` (sessionStorage) | Prevents duplicate recovery across HMR |
| `recoveringDocs` | `Set<string>` | Documents currently being recovered (skip sync) |
| `manifestFlushGeneration` | `number` | Incremented on clearStorage to abort stale flushes |

---

## Reactor Internals (Reference)

### Event-Sourced Storage

```
Client Action → Job Queue → Reducer (pure fn) → Operation Store (PGlite)
                                                        ↓
                                             Read Model Coordinator
                                                        ↓
                          ┌──────────────────────┬──────┴──────────────────┐
                Pre-ready Read Models      Post-ready Read Models     Processors
                (DocumentView,               (ProcessorManager)      (swarm-plugin)
                 DocumentIndexer)
```

### Job Lifecycle

```
PENDING → RUNNING → WRITE_READY → READ_READY
                 ↘ FAILED
```

- `WRITE_READY` = Operations persisted to PGlite
- `READ_READY` = All read models updated (DocumentView, DocumentIndexer)
- Our plugin fires on `READ_READY` events

### Key Reactor APIs Used by the Plugin

| API | What it does |
|-----|-------------|
| `reactorClient.get(id)` | Get a document by ID (NOT `getDocument`) |
| `reactorClient.getDocumentModelModule(type)` | Get document model utils (for creating default state) |
| `reactorClient.execute(docId, branch, ops)` | Replay operations on a document |
| `reactorClient.addDrive(...)` | Create a new local drive |
| `driveClient.addDocument(driveId, doc)` | Add a document to a drive |
| Subscriber callback | Fires on every document change with operation details |
