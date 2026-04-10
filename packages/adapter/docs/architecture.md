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

## Upload / Encryption / Download / Decryption

Two separate layers handle data storage and discovery:

```
WRITE PATH (upload):

  1. Plugin calls uploadData(JSON.stringify(ops))
  2. SwarmClient encrypts with AES-256-GCM → [SWE prefix][IV][ciphertext+tag]
  3. Encrypted bytes uploaded to Swarm /bytes → returns 64-char content hash (reference)
  4. Reference written to feed via writeFeedPayload(topic, reference)
     Feed SOC contains ONLY the reference (a pointer) — never encrypted data

READ PATH (download):

  1. Reader reads feed → gets reference (64-char hex hash)
  2. Uses reference to download from /bytes → gets encrypted bytes
  3. SwarmClient detects SWE prefix (0x535745) → decrypts with AES-256-GCM
  4. Returns plaintext JSON
```

**Key principle: encryption lives at the `/bytes` layer, NOT the feed layer.**
Feeds store plain-text references (content hashes). The data those references point to is encrypted. Anyone can read the feed and get the reference, but they can't decrypt the data without the wallet-derived AES key.

This separation is why feed-level optimizations (like `uploadReference` vs `uploadPayload`) don't affect encryption — they only change how the 64-char hash is stored in the SOC, not the encrypted data at `/bytes`.

**Sharing uses a different key**: instead of the wallet-derived key, shared data is encrypted with `SHA-256(sender_address:recipient_address)`. Both parties can derive the same key. The share manifest itself is unencrypted (the feed topic is obscure enough — requires knowing both signer addresses).

---

## The Three Layers

### Layer 1: bee-reactor-adapter (npm package)

The `SwarmClient` class wraps the Bee SDK and provides:

| Method | What it does |
|--------|-------------|
| `uploadData(data)` | Encrypt with AES-256-GCM + upload to /bytes → returns content hash |
| `downloadData(ref)` | Download from /bytes + auto-decrypt if SWE prefix detected |
| `uploadSharedData(data, sender, recipient)` | Encrypt with SHA-256 shared key + upload to /bytes |
| `downloadSharedData(ref, sender, recipient)` | Download from /bytes + decrypt with shared key |
| `updateManifest(docId, manifest)` | Upload manifest to /bytes (encrypted), write reference to feed |
| `readManifest(docId)` | Read feed → dereference → download from /bytes → decrypt → parse |
| `updateDriveManifest(driveId, manifest)` | Same pattern for drive-level manifest |
| `updateUserManifest(address, manifest)` | Same pattern for user-level index |
| `getStampStatus()` | Postage stamp health, capacity, cost |
| `grantAccess() / revokeAccess()` | ACT access control (built, not yet integrated into sharing) |

The client also handles:
- **Per-topic write locks** — prevents concurrent feed writes from getting the same index
- **3-retry with backoff** — handles Swarm propagation delays on feed writes
- **Auto-detect feed format** — reference (64-char hex) vs inline JSON (legacy)

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

Each user has a feed at topic `ph:v2:user:<eth_address>`. It indexes their drives (not individual docs):

```json
{
  "address": "0x1234...",
  "beeNodePublicKey": "02abc...",
  "documents": {},
  "drives": {
    "drive-xyz": {
      "name": "My Finance Drive",
      "documentIds": [],
      "lastUpdated": "2026-04-07T10:05:00Z"
    }
  },
  "updatedAt": "2026-04-07T10:05:00Z"
}
```

### Per-Drive: Drive Manifest

Each drive has a feed at topic `ph:v2:drive:<driveId>`. It lists all documents and folders in that drive:

```json
{
  "driveId": "drive-xyz",
  "name": "My Finance Drive",
  "documents": {
    "abc-123": {
      "documentType": "powerhouse/budget-statement",
      "name": "Q1 Budget",
      "parentFolder": "folder-1",
      "lastUpdated": "2026-04-07T10:05:00Z"
    },
    "def-456": {
      "documentType": "powerhouse/document-model",
      "name": "Root Doc",
      "lastUpdated": "2026-04-07T10:05:00Z"
    }
  },
  "folders": {
    "folder-1": { "name": "Reports" },
    "folder-2": { "name": "Subfolder", "parentFolder": "folder-1" }
  },
  "updatedAt": "2026-04-07T10:05:00Z"
}
```

Recovery reads each drive manifest to discover docs and their folder structure. Folder info is tracked by reading the drive's node tree during each flush.

### Feed Write Pattern: Manifest-as-Reference

Instead of writing the full manifest JSON into the feed (which can be large and slow), we use the "regenerate and publish" pattern:

```
1. Serialize manifest → JSON string
2. Encrypt with AES-256-GCM → encrypted bytes
3. Upload to /bytes → get 64-char content hash
4. Write ONLY the hash to the feed → 72-byte SOC (8-byte timestamp + 64-byte reference)
```

Reading reverses this: read feed → get hash → download from /bytes → decrypt → parse JSON.

---

## Recovery Flow (Swarm → Browser)

When a user opens Connect on a new device (or after clearing browser data):

```
1. User connects wallet (MetaMask)
2. Plugin requests personal_sign → derives the SAME Swarm key as before
3. Read user manifest from feed: ph:v2:user:<address>
4. Read drive manifests for each drive listed in the user manifest
5. For each document in the drive manifests that doesn't exist locally:

   a. Create a local drive for each unique driveId (with correct name)
   b. For each document in the drive:
      - Read document manifest from feed: ph:v2:doc:<docId>
      - Download each operation batch from /bytes (auto-decrypted)
      - Get the document model's default state via reactorClient.getDocumentModelModule(type)
      - Create a shell document in the local drive
      - Replay all operations via reactorClient.execute(docId, "main", ops)
      - Mark as synced in syncedRevisions map
   c. Restore folder structure from drive manifest:
      - Execute ADD_FOLDER actions for each folder (with id, timestampUtcMs, scope: "global")
      - Execute MOVE_NODE actions to place docs in their folders

6. Write a clean user manifest (only recovered drives, no stale entries)
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

Connect organizes documents into drives with optional folder structure. On Swarm, we preserve this via hierarchical manifests:

- **User manifest** — lists drives (name only)
- **Drive manifest** — lists all documents + folder structure for one drive
- **Document manifest** — lists operation batches for one document

The `docToDrive` map tracks confirmed drive→doc relationships. The `driveManifestCache` is the local source of truth for drive contents (avoids stale reads from Swarm during rapid writes).

### Folder Structure

During each drive manifest flush, the plugin reads the drive's `state.global.nodes` tree and extracts:
- **Folder nodes** → stored in `manifest.folders` (id → name + parentFolder)
- **File nodes** → `parentFolder` set on the document entry in the manifest

During recovery, folders are restored by executing ADD_FOLDER and MOVE_NODE actions on the drive. These actions require the full `createAction()` shape: `id`, `timestampUtcMs`, `type`, `input`, `scope: "global"`.

---

## Module-Level State in swarm-plugin.ts

The plugin maintains several maps and flags at module scope (persisted across function calls within the same browser session):

| State | Type | Purpose |
|-------|------|---------|
| `syncedRevisions` | `Map<string, number>` | Last synced op index per document — prevents re-uploading |
| `docToDrive` | `Map<string, string>` | Confirmed document → drive relationships |
| `driveNames` | `Map<string, string>` | Known drive names (for manifest writes) |
| `driveManifestCache` | `Map<string, SwarmDriveManifest>` | Local source of truth for drive contents (avoids stale Swarm reads) |
| `pendingManifests` | `Map<string, manifest>` | In-memory doc manifests waiting for debounce flush |
| `pendingOps` | `Map<string, ops[]>` | Buffered operations waiting for batch upload |
| `docManifestTimers` | `Map<string, timeout>` | Active debounce timers per document |
| `pendingDriveUpdates` | `Map<string, Map<docId, entry>>` | Pending drive manifest updates (batched) |
| `driveManifestTimers` | `Map<string, timeout>` | Active debounce timers per drive manifest |
| `driveManifestFlushInProgress` | `Map<string, Promise>` | Write lock per drive manifest |
| `pendingManifestDriveUpdates` | `Map<string, entry>` | Pending user manifest drive entries |
| `manifestFlushTimer` | `timeout \| null` | Active debounce timer for user manifest |
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

---

## Architecture Decision Records

### ADR-001: Split swarm-plugin.ts into plugin/ module

**Status:** Accepted (2026-04-10)

**Context:** The original `swarm-plugin.ts` was 2,576 lines with 7 tangled concerns and ~20 module-level mutable variables. Impossible to reason about individual flows.

**Decision:** Split into 6 files in `src/plugin/`: state.ts (shared state), init.ts (orchestrator), sync.ts (reactor subscriber), flush.ts (debounced writes), hydration.ts (recovery), sharing.ts (share/import). A thin `swarm-plugin.ts` re-exports the entry point.

**Consequences:**
- Positive: Each file has a single responsibility. State is centralized. Flows are traceable.
- Positive: `restoreFolderStructure` deduplicated between hydration and import.
- Negative: 6 files instead of 1; more imports to manage. Clean DAG prevents circular deps.

### ADR-002: Extract StampManager and ShareManager from SwarmClient

**Status:** Accepted (2026-04-10)

**Context:** `SwarmClient` was 1,035 lines with ~30 methods covering 10 responsibilities (data CRUD, feeds, stamps, pricing, sharing, profiles, ACT, compaction).

**Decision:** Extract `StampManager` (stamp lifecycle + pricing) and `ShareManager` (profiles + sharing + key derivation) as separate classes. SwarmClient keeps thin delegation methods for backward compatibility.

**Consequences:**
- Positive: SwarmClient focused on core CRUD + feeds + manifests (531 lines).
- Positive: StampManager and ShareManager independently testable.
- Negative: SwarmClient has delegation wrappers that add indirection.

### ADR-003: Injectable dependencies for testability

**Status:** Accepted (2026-04-10)

**Context:** All major classes hard-coded their dependencies (`new Bee(...)`, `window.ethereum`, `new SwarmClient(...)`) — impossible to unit test without global mocks.

**Decision:** Add optional dependency injection parameters:
- `SwarmClient`: optional `bee: Bee` instance
- `wallet-signer`: optional `provider: EthereumProvider`
- `BeeReactorAdapter`: optional `deps: { swarmClient?, hydrator? }`

All parameters are optional — defaults preserve existing behavior.

**Consequences:**
- Positive: Unit tests can inject mocks. No global patching needed.
- Positive: Zero breaking changes — all injection points are optional.

### ADR-004: Serialize all manifest writes to prevent lost-update races

**Status:** Accepted (2026-04-10)

**Context:** User manifest updates used unserialized read-modify-write. Two concurrent document syncs could lose each other's manifest entries.

**Decision:** Per-address write lock (`userManifestLocks`) in `SwarmSyncReadModel`. Debounced pipeline with generation counter in the plugin. `reconcileUserManifest` routes through the debounced pipeline instead of writing directly.

**Consequences:**
- Positive: No lost-update races on user manifest.
- Trade-off: Slightly higher latency for user manifest writes (debounce + lock wait).

### ADR-005: Ops buffer cleared only on full success (atomic flush)

**Status:** Accepted (2026-04-10)

**Context:** `flushDocumentManifest` deleted ops from the buffer before attempting upload. If `uploadData` succeeded but `updateManifest` failed, ops were re-queued but the manifest had a stale duplicate batch entry.

**Decision:** Snapshot ops (don't delete), deep-copy the manifest before mutation, and only delete from buffer after both `uploadData` AND `updateManifest` succeed.

**Consequences:**
- Positive: Partial failure cannot create duplicate batches or corrupt in-memory manifest.
- Positive: Retry path is clean — same ops, same manifest state as before the attempt.

### ADR-006: Drive matching by name, not position

**Status:** Accepted (2026-04-10)

**Context:** Hydration matched Swarm drives to local drives by array position. Any locally-created drive that wasn't on Swarm shifted all indices, injecting recovered docs into the wrong drive.

**Decision:** Match by drive name. Only reuse a local drive if its `state.global.name` matches the Swarm drive's name. Create new drives for unmatched entries.

**Consequences:**
- Positive: Correct matching even with extra local drives.
- Trade-off: If the user renames a drive locally but hasn't synced, it won't match. New drive created (acceptable — data is not lost).

---

## Testing Architecture

### Test Strategy

The adapter has injectable dependencies at every boundary, enabling 3 levels of testing:

#### Level 1: Unit Tests (fast, no network)

Test individual modules with mock dependencies:

| Module | What to test | Mock |
|--------|-------------|------|
| `swarm-crypto.ts` | encrypt → decrypt roundtrip, SWE prefix detection | None (pure functions, uses Web Crypto) |
| `bytes-utils.ts` | hexToBytes/bytesToHex roundtrip | None (pure functions) |
| `wallet-signer.ts` | `deriveSwarmKey` determinism, `buildSignMessage` format | `EthereumProvider` mock for `requestSwarmKeyFromWallet` |
| `stamp-manager.ts` | Status parsing, cost estimation, preset generation | Mock `Bee` instance |
| `share-manager.ts` | Share key derivation, profile read/write | Mock `SwarmClient` |
| `types.ts` | `createEmptyManifest` factory | None |

#### Level 2: Integration Tests (live Bee node)

Test end-to-end data paths against `bee dev`:

| Flow | Test |
|------|------|
| **Upload → Download** | `uploadData` → `downloadData` roundtrip with encryption |
| **Manifest CRUD** | `updateManifest` → `readManifest` roundtrip (bytes mode) |
| **Feed CRUD** | `writeFeedPayload` → `readFeedJson` roundtrip (requires real Bee, not dev) |
| **User Manifest** | `updateUserManifest` → `readUserManifest` roundtrip |
| **Drive Manifest** | `updateDriveManifest` → `readDriveManifest` roundtrip |
| **Compaction** | Upload 30 batches → `compactManifest` → verify single batch, same ops |
| **Sharing** | `uploadSharedData` → `downloadSharedData` with matching/mismatched keys |

#### Level 3: E2E Flow Tests (plugin simulation)

Test the 6 user flows with a mock `reactorClient` and real `SwarmClient`:

| Flow | What to verify |
|------|---------------|
| **Create** | New doc triggers subscriber → ops buffered → flush → all 3 manifests updated |
| **Sync** | 10 rapid edits → debounce → 1 upload + 1 feed write |
| **Recover** | Write manifests → clear local state → `hydrateFromSwarm` → all docs restored with correct drive assignment and folder structure |
| **Share** | Flush pending → bundle by drive → encrypt → share manifest written → recipient can import |
| **Import** | Read share manifest → download → decrypt → correct drives/folders created |
| **Clear Cache** | Empty manifests written → auto-reconnect → `syncPaused` resets → new sync works |

### Test Infrastructure

Existing test file: `tests/integration.test.ts` (12 tests against `bee dev`).

Recommended additions:
```
tests/
  unit/
    swarm-crypto.test.ts      — encrypt/decrypt roundtrips
    bytes-utils.test.ts       — hex conversion
    wallet-signer.test.ts     — key derivation with mock provider
    stamp-manager.test.ts     — status parsing with mock Bee
    share-manager.test.ts     — share key + profile with mock client
  integration/
    integration.test.ts       — existing tests (SwarmClient against bee dev)
    manifest-flush.test.ts    — debounced flush pipeline
    compaction.test.ts        — manifest compaction per scope/branch
  e2e/
    create-sync-recover.test.ts  — full create → sync → recover flow
    share-import.test.ts         — full share → import flow
    clear-cache.test.ts          — clear → reconnect → sync flow
```

### Running Tests

```bash
# Unit tests (no Bee node needed)
pnpm test:unit

# Integration tests (requires bee dev running on localhost:1633)
bee dev &
pnpm test:integration

# All tests
pnpm test
```
