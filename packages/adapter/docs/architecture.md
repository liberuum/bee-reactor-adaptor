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
│  SyncManager detects new ordinals in operation_index_operations          │
│       ↓                                                                   │
│  SwarmChannel.outbox: encrypt → upload to Swarm /bytes → update feed     │
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

### Layer 2: SwarmChannel (native IChannel implementation)

SwarmChannel implements the reactor's `IChannel` interface. It is wired into the
reactor via `ReactorBuilder.withSync()` and a `CompositeChannelFactory` that
routes `"swarm"` and `"gql"` config types to the appropriate sub-factory.

**Push (outbox):** SyncManager detects new ordinals → groups ops into SyncOperations
→ SwarmChannel serializes, encrypts, uploads to /bytes, writes reference to feed,
updates drive/user manifests via ManifestManager.

**Pull (inbox):** SwarmChannel polls user manifest → discovers drives → reads drive
manifests → reads document manifests → downloads operation batches from /bytes →
decrypts → creates SyncOperations → adds to inbox → SyncManager applies via
`reactor.load()`.

**Cursor tracking:** `sync_cursors` in PGlite (survives page reload). No custom
persistence needed.

**Dead letters:** Failed operations go to `sync_dead_letters` — persisted, queryable,
retryable.

The plugin layer (`plugin/init.ts`) still handles Bee node detection, stamp
selection, wallet key derivation, and UI event emission. The sharing flow
(`plugin/sharing.ts`) operates independently of the sync channel.

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
3. SwarmChannel.pollInbox() reads user manifest from feed: ph:v2:user:<address>
4. Read drive manifests for each drive listed in the user manifest
5. For each document in the drive manifests that doesn't exist locally:
   - Read document manifest from feed: ph:v2:doc:<docId>
   - Download each operation batch from /bytes (auto-decrypted)
   - Create SyncOperations and add to inbox
   - SyncManager applies via reactor.load() with ORIGINAL document IDs
   - Cursor advances in sync_cursors
6. Drive materializes in PGlite with correct folder structure
7. Future polls are incremental (cursor-based)
```

Key details:
- **Cursor-based** — `sync_cursors` in PGlite tracks exactly what has been synced, survives page reload
- **No race conditions** — SyncManager processes inbox before outbox; no re-upload of recovered ops
- **Dead letter handling** — failed operations go to `sync_dead_letters` for retry

---

## Write Optimization

The SyncManager batches operations by (documentId, scope, branch) into
SyncOperations. SwarmChannel uploads each batch as a single /bytes entry
and writes one feed update per document. ManifestManager handles drive
and user manifest updates.

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

## Sync State

Sync state is managed by the reactor's SyncManager and persisted in PGlite:

| Table | Purpose |
|-------|---------|
| `sync_remotes` | Registered remotes with channel_type, push/pull state, failure counts |
| `sync_cursors` | Per-remote ordinal-based cursor tracking (inbox and outbox) |
| `sync_dead_letters` | Failed operations with error details for retry |

The plugin layer (`plugin/state.ts`) maintains only UI-related state:
Bee URL, UI cache fields, and drive mapping for the settings panel.

---

## Reactor Internals (Reference)

### Event-Sourced Storage

```
Client Action → Job Queue → Reducer (pure fn) → Operation Store (PGlite)
                                                        ↓
                                             Read Model Coordinator
                                                        ↓
                          ┌──────────────────────┬──────┴──────────────────┐
                Pre-ready Read Models      Post-ready Read Models     Sync Channels
                (DocumentView,               (ProcessorManager)      (SwarmChannel,
                 DocumentIndexer)                                     GqlChannel)
```

### Job Lifecycle

```
PENDING → RUNNING → WRITE_READY → READ_READY
                 ↘ FAILED
```

- `WRITE_READY` = Operations persisted to PGlite
- `READ_READY` = All read models updated (DocumentView, DocumentIndexer)
- SyncManager detects new ordinals and populates channel outboxes

### Key Reactor APIs

| API | What it does |
|-----|-------------|
| `reactorClient.get(id)` | Get a document by ID (NOT `getDocument`) |
| `reactorClient.getDocumentModelModule(type)` | Get document model utils (for creating default state) |
| `reactorClient.addDrive(...)` | Create a new local drive |
| `syncManager.add(remoteName, collectionId, config)` | Register a sync remote (Swarm or GQL) |
| `reactor.load(docId, branch, ops)` | Apply remote operations to a document |

---

## Architecture Decision Records

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

All parameters are optional — defaults preserve existing behavior.

**Consequences:**
- Positive: Unit tests can inject mocks. No global patching needed.
- Positive: Zero breaking changes — all injection points are optional.

---

## Testing

See [testing.md](testing.md) for the full testing guide including test structure,
running commands, and configuration.
