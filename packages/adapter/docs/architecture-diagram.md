# Swarm Connect — Architecture Diagrams

## The Core Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER'S BROWSER                              │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                     CONNECT APP                               │  │
│  │  (React UI — drive explorer, document editors, settings)      │  │
│  │                                                               │  │
│  │  User creates drive → adds docs → creates folders → edits    │  │
│  └──────────────────────┬───────────────────────────────────────┘  │
│                          │                                          │
│                          │ React dispatches actions                  │
│                          ▼                                          │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                   REACTOR CLIENT                              │  │
│  │                                                               │  │
│  │  Receives actions → creates Jobs → enqueues to Queue          │  │
│  │  Job types: create, execute, load, delete                     │  │
│  │                                                               │  │
│  │  ┌─────────────────────────────────────────────────────────┐ │  │
│  │  │              JOB EXECUTOR                                │ │  │
│  │  │                                                          │ │  │
│  │  │  Processes jobs → applies actions to documents           │ │  │
│  │  │  CREATE_DOCUMENT → UPGRADE_DOCUMENT → SET_DRIVE_NAME    │ │  │
│  │  │  ADD_FILE → ADD_FOLDER → MOVE_NODE → domain actions     │ │  │
│  │  └──────────────┬──────────────────────────────────────────┘ │  │
│  │                  │                                            │  │
│  │                  │ Operations written                         │  │
│  │                  ▼                                            │  │
│  │  ┌─────────────────────────────────────────────────────────┐ │  │
│  │  │              PGlite (WASM Postgres)                      │ │  │
│  │  │                                                          │ │  │
│  │  │  reactor.Document         — doc registry                 │ │  │
│  │  │  reactor.Operation        — full operation log           │ │  │
│  │  │  reactor.DocumentSnapshot — current state per scope      │ │  │
│  │  │  reactor.DocumentRelationship — drive→doc child links    │ │  │
│  │  │  reactor.operation_index_operations — global ordinals    │ │  │
│  │  │  reactor.sync_remotes     — registered sync channels     │ │  │
│  │  │  reactor.sync_cursors     — per-remote sync position     │ │  │
│  │  │  reactor.sync_dead_letters — failed sync operations      │ │  │
│  │  │                                                          │ │  │
│  │  │  Persisted in IndexedDB (survives page reload)           │ │  │
│  │  └──────────────┬──────────────────────────────────────────┘ │  │
│  │                  │                                            │  │
│  │                  │ New ordinals in operation_index_operations  │  │
│  │                  ▼                                            │  │
│  │  ┌─────────────────────────────────────────────────────────┐ │  │
│  │  │              SYNC MANAGER                                │ │  │
│  │  │                                                          │ │  │
│  │  │  Detects new ordinals → groups by (docId, scope, branch) │ │  │
│  │  │  Creates SyncOperations → populates channel outboxes     │ │  │
│  │  │  Processes inbox items → calls reactor.load()            │ │  │
│  │  │  Tracks cursors in sync_cursors (survives reload)        │ │  │
│  │  │  Moves failures to sync_dead_letters                     │ │  │
│  │  │                                                          │ │  │
│  │  │  ┌─────────────────┐  ┌──────────────────────────────┐  │ │  │
│  │  │  │  GQL Channel    │  │  SWARM CHANNEL               │  │ │  │
│  │  │  │  (type: "gql")  │  │  (type: "swarm")             │  │ │  │
│  │  │  │                 │  │                               │  │ │  │
│  │  │  │  For Switchboard│  │  ┌─────────┐ ┌────────────┐  │  │ │  │
│  │  │  │  cloud sync     │  │  │ OUTBOX  │ │  INBOX     │  │  │ │  │
│  │  │  │  (remote drives)│  │  │ (push)  │ │  (pull)    │  │  │ │  │
│  │  │  │                 │  │  └────┬────┘ └─────┬──────┘  │  │ │  │
│  │  │  └─────────────────┘  └───────┼────────────┼─────────┘  │ │  │
│  │  └───────────────────────────────┼────────────┼────────────┘ │  │
│  └──────────────────────────────────┼────────────┼──────────────┘  │
│                                      │            │                 │
└──────────────────────────────────────┼────────────┼─────────────────┘
                                       │            │
                    Push: encrypt +    │            │  Pull: read feed +
                    upload /bytes +    │            │  download /bytes +
                    write feed         │            │  decrypt
                                       │            │
                                       ▼            │
                              ┌─────────────────────┴──────┐
                              │        BEE NODE             │
                              │   (user's local node)       │
                              │                             │
                              │  /bytes  — content storage  │
                              │  /feeds  — mutable pointers │
                              │  /stamps — postage batches  │
                              │  /health — node status      │
                              │                             │
                              └──────────────┬──────────────┘
                                             │
                                             │ Swarm protocol
                                             │ (DISC, push-sync, pull-sync)
                                             ▼
                              ┌────────────────────────────┐
                              │      SWARM NETWORK          │
                              │   (decentralized storage)   │
                              │                             │
                              │  Chunks replicated across   │
                              │  neighborhood nodes         │
                              │  Content-addressed (hash)   │
                              │  Encrypted (AES-256-GCM)    │
                              │                             │
                              └────────────────────────────┘
```

## Push Flow (Create → Sync to Swarm)

```
User creates "PushPullDrive" with doc "push" + folder "folder" + doc "docs"
     │
     ▼
ReactorClient.create() / execute() / createDocumentInDrive()
     │
     │  Generates operations:
     │  Op 0: CREATE_DOCUMENT (drive dbebae62)
     │  Op 1: UPGRADE_DOCUMENT (name: "PushPullDrive")
     │  Op 2: ADD_FILE (doc 57033542, name: "push")
     │  Op 3: ADD_FOLDER (folder, name: "folder")
     │  Op 4: ADD_FILE (doc d03fd76d, name: "docs", parentFolder: folder)
     │  Op 5: MOVE_NODE (doc d03fd76d → folder)
     │
     ▼
PGlite — operations stored in reactor.Operation + operation_index_operations
     │
     │  New ordinals detected by SyncManager
     ▼
SyncManager.updateOutbox()
     │
     │  Groups ops by (documentId, scope, branch)
     │  Creates SyncOperation objects
     │  Adds to SwarmChannel.outbox
     ▼
SwarmChannel.handleOutboxAdded()
     │
     ├─── For each SyncOperation:
     │    │
     │    ├── 1. Serialize OperationWithContext[] → JSON
     │    ├── 2. Encrypt with AES-256-GCM (wallet-derived key)
     │    ├── 3. Upload to /bytes → get content reference (hash)
     │    ├── 4. Read document manifest from feed (or create new)
     │    ├── 5. Append batch reference to manifest
     │    ├── 6. Write updated manifest to feed (SOC)
     │    └── 7. syncOp.executed() → cursor advances
     │
     ├─── If documentType is "powerhouse/document-drive":
     │    │
     │    ├── ManifestManager.updateDriveManifest()
     │    │   → Reads drive state from reactor
     │    │   → Writes docs + folders index to drive manifest feed
     │    │
     │    └── ManifestManager.ensureDriveInUserManifest()
     │        → Updates user manifest with drive entry
     │        → Discovery index for recovery
     │
     ▼
Swarm Network — operations stored as encrypted chunks
     │
     │  Feed structure:
     │  user-manifest (owner feed) → { drives: { dbebae62: {...} } }
     │  drive-manifest (drive feed) → { documents: {...}, folders: {...} }
     │  doc-manifest (per-doc feed) → { operationBatches: [{ref, indices}] }
     │  operation batches (/bytes)  → encrypted OperationWithContext[]
```

## Pull Flow (Recovery from Swarm)

```
Fresh PGlite (new device or cleared storage)
     │
     │  No local drives exist
     ▼
Registration retry loop checks Swarm user manifest
     │
     │  readUserManifest(ownerAddress)
     │  → Found 1 drive: "PushPullDrive" (dbebae62)
     ▼
addSwarmRemoteForDrive("dbebae62")
     │
     │  syncManager.add("swarm:dbebae62", collectionId, { type: "swarm" })
     │  → Creates SwarmChannel instance
     │  → Registers in sync_remotes
     │  → Starts inbox poll timer (5s interval)
     ▼
SwarmChannel.pollInbox()
     │
     ├── 1. Read user manifest → discover drive IDs
     ├── 2. Read drive manifest → discover doc IDs + folder structure
     ├── 3. For each document:
     │      ├── Read document manifest → get operation batch references
     │      ├── Download each batch from /bytes
     │      ├── Decrypt AES-256-GCM → OperationWithContext[]
     │      ├── Group by scope (document scope first, then global)
     │      └── Create SyncOperation → inbox.add(syncOp)
     │
     ▼
SyncManager.handleInboxAdded()
     │
     │  For each SyncOperation:
     │  │
     │  ├── reactor.load(documentId, branch, operations)
     │  │   │
     │  │   │  Operations contain CREATE_DOCUMENT with ORIGINAL ID
     │  │   │  → Reactor creates document with that exact ID
     │  │   │  → No ID mismatch! No mapping needed!
     │  │   │
     │  │   ├── Op 0: CREATE_DOCUMENT → creates drive dbebae62
     │  │   ├── Op 1: UPGRADE_DOCUMENT → sets name "PushPullDrive"
     │  │   ├── Op 2: CREATE_DOCUMENT → creates doc 57033542
     │  │   ├── Op 3: CREATE_DOCUMENT → creates doc d03fd76d
     │  │   ├── Op 4+: Domain actions (SET_MODEL_NAME, etc.)
     │  │   └── Op N: ADD_FILE, ADD_FOLDER, MOVE_NODE → folder structure
     │  │
     │  └── syncOp.executed() → inbox cursor advances → persisted in sync_cursors
     │
     ▼
PGlite now contains the full drive with ORIGINAL IDs
     │
     │  reactor.Document: dbebae62, 57033542, d03fd76d
     │  reactor.DocumentSnapshot: full state for each
     │  reactor.DocumentRelationship: drive → doc child links
     │  reactor.Operation: complete operation history
     │
     ▼
Connect UI renders the recovered drive
     │
     │  PushPullDrive/
     │    push          (57033542)
     │    folder/
     │      docs        (d03fd76d)
```

## The Bridge Pattern (GQL + Swarm Dual Sync)

```
  Switchboard World              User's Browser              Swarm World
  ─────────────────           ──────────────────          ─────────────────

  ┌─────────────────┐         ┌────────────────┐         ┌────────────────┐
  │  Remote Drive A  │         │                │         │                │
  │  (Switchboard)   │──GQL──▶│    PGlite      │──Swarm─▶│  Feed A        │
  └─────────────────┘  pull   │   (reactor)    │  push   │  (encrypted)   │
                               │                │         │                │
  ┌─────────────────┐         │  operation_    │         ├────────────────┤
  │  Remote Drive B  │         │  index_       │         │                │
  │  (Switchboard)   │──GQL──▶│  operations    │──Swarm─▶│  Feed B        │
  └─────────────────┘  pull   │                │  push   │  (encrypted)   │
                               │  Each op gets  │         │                │
                               │  a global      │         ├────────────────┤
                               │  ordinal       │         │                │
  (not connected)              │                │──Swarm─▶│  Feed C        │
                               │  Local Drive C │  push   │  (encrypted)   │
                               │  (user created)│         │                │
                               └────────────────┘         └────────────────┘

  Both channels share the same operation_index_operations table.
  Each has independent cursors in sync_cursors.
  SyncManager orchestrates both transparently.
```

## CompositeChannelFactory — How Two Channels Coexist

```
ReactorBuilder
  │
  │  .withChannelScheme(ChannelScheme.CONNECT)
  │  → Creates GqlRequestChannelFactory internally
  │
  │  After build:
  ▼
patchReactorBuilderForSwarm()
  │
  │  Wraps the GQL factory in CompositeChannelFactory
  │  Adds SwarmChannelFactory alongside
  ▼
CompositeChannelFactory
  │
  │  .instance(config)
  │  │
  │  ├── config.type === "gql"   → GqlRequestChannelFactory → GqlRequestChannel
  │  │                              (for Switchboard remotes)
  │  │
  │  └── config.type === "swarm" → SwarmChannelFactory → SwarmChannel
  │                                 (for Swarm storage)
  │
  ▼
SyncManager
  │
  │  Treats all remotes the same:
  │  - Populates outbox from operation_index_operations
  │  - Processes inbox via reactor.load()
  │  - Tracks cursors per remote
  │  - Dead letter handling per remote
  │
  │  Doesn't care about channel type — just calls
  │  channel.outbox / channel.inbox / channel.deadLetter
```

## Manifest Structure on Swarm

```
User Manifest (one per user, keyed by Ethereum address)
  │
  │  Feed topic: keccak256("ph:v2:user:" + ownerAddress)
  │
  │  {
  │    address: "0xadbA7C2F...",
  │    drives: {
  │      "dbebae62-...": {
  │        name: "PushPullDrive",
  │        preferredEditor: "GenericDriveExplorer",
  │        documentIds: [],
  │        lastUpdated: "2026-04-11T18:52:..."
  │      }
  │    },
  │    documents: { ... },
  │    stamps: { ... }
  │  }
  │
  └─── Drive Manifest (one per drive, keyed by drive ID)
        │
        │  Feed topic: keccak256("ph:v2:drive:" + driveId)
        │
        │  {
        │    driveId: "dbebae62-...",
        │    name: "PushPullDrive",
        │    preferredEditor: "GenericDriveExplorer",
        │    documents: {
        │      "57033542-...": { documentType: "powerhouse/document-model", name: "push" },
        │      "d03fd76d-...": { documentType: "powerhouse/document-model", name: "docs", parentFolder: "folder-id" }
        │    },
        │    folders: {
        │      "folder-id": { name: "folder", parentFolder: null }
        │    }
        │  }
        │
        └─── Document Manifests (one per document, keyed by doc ID)
              │
              │  Feed topic: keccak256("ph:v2:doc:" + docId)
              │
              │  {
              │    documentId: "57033542-...",
              │    documentType: "powerhouse/document-model",
              │    operationBatches: [
              │      { reference: "abc123...", scope: "document", startIndex: 0, endIndex: 1 },
              │      { reference: "def456...", scope: "global",   startIndex: 0, endIndex: 7 }
              │    ],
              │    latestRevision: { document: 2, global: 8 },
              │    keyframes: []
              │  }
              │
              └─── Operation Batches (content-addressed /bytes)
                    │
                    │  Reference: content hash of encrypted payload
                    │
                    │  Encrypted OperationWithContext[]:
                    │  [
                    │    {
                    │      operation: {
                    │        id: "c6401aec-...",
                    │        index: 0,
                    │        skip: 0,
                    │        timestampUtcMs: "2026-04-11T18:06:34.210Z",
                    │        hash: "gfgqmD...",
                    │        action: {
                    │          type: "CREATE_DOCUMENT",
                    │          input: { name: "push", model: "powerhouse/document-model", ... },
                    │          scope: "document",
                    │          context: { signer: { user: { address: "0xadbA7C2F..." } } }
                    │        }
                    │      },
                    │      context: {
                    │        documentId: "57033542-...",
                    │        documentType: "powerhouse/document-model",
                    │        scope: "document",
                    │        branch: "main",
                    │        ordinal: 5
                    │      }
                    │    },
                    │    ...
                    │  ]
```

## Security Model

```
┌──────────────────────────────────────────────────────┐
│                    ENCRYPTION                         │
│                                                       │
│  Wallet Signature (one-time)                          │
│  │                                                    │
│  │  personal_sign("Sign to derive Swarm key...")      │
│  │  → keccak256(signature) → 32-byte private key      │
│  │  → Cached in IndexedDB (no repeated signing)       │
│  │                                                    │
│  ▼                                                    │
│  AES-256-GCM Encryption                              │
│  │                                                    │
│  │  Every operation batch uploaded to /bytes is        │
│  │  encrypted before upload and decrypted after        │
│  │  download. The key is derived from the wallet       │
│  │  signature — same wallet = same key = same access.  │
│  │                                                    │
│  │  Format: [SWE prefix (3B)] [IV (12B)] [ciphertext] │
│  │                                                    │
│  ▼                                                    │
│  Feed Authentication                                  │
│  │                                                    │
│  │  Feeds are signed with the Swarm private key        │
│  │  (derived from wallet). Only the owner can write.   │
│  │  Anyone with the owner's public key can read.       │
│  │                                                    │
│  ▼                                                    │
│  Cross-User Sharing                                   │
│  │                                                    │
│  │  SHA-256(senderAddress + recipientAddress)           │
│  │  → Derived shared key for AES-256-GCM               │
│  │  → Both parties can derive the same key              │
│  │  → Shared feed: deterministic topic from both IDs    │
│                                                       │
└──────────────────────────────────────────────────────┘
```

## File Structure (adapter/src/channel/)

```
adapter/src/channel/
  │
  ├── index.ts                    — Public exports
  ├── composite-factory.ts        — Routes "gql"/"swarm" to sub-factories
  ├── swarm-channel.ts            — IChannel: outbox push + inbox pull
  ├── swarm-channel-factory.ts    — Creates SwarmChannel from ChannelConfig
  ├── register-swarm-channel.ts   — Post-build factory injection
  ├── add-swarm-remote.ts         — Per-drive Swarm remote registration
  ├── manifest-manager.ts         — User + drive manifest writes
  └── create-composite-factory.ts — Helper for future direct SyncBuilder use

adapter/src/ (kept — infrastructure)
  │
  ├── swarm-client.ts             — Bee API: upload, download, feeds, encrypt
  ├── swarm-crypto.ts             — AES-256-GCM encryption
  ├── wallet-signer.ts            — Key derivation from wallet signature
  ├── stamp-manager.ts            — Postage stamp lifecycle
  ├── share-manager.ts            — Cross-user sharing
  ├── folder-tree.ts              — Recursive tree builder
  ├── types.ts                    — Manifest and operation types
  ├── swarm-operation-store.ts    — IOperationStore interface
  └── swarm-keyframe-store.ts     — IKeyframeStore interface

adapter/src/plugin/ (cleaned — supports SwarmChannel architecture)
  │
  ├── init.ts         — 508 lines — Orchestrator: Bee detection, stamps, wallet, events
  ├── sharing.ts      — 394 lines — Cross-user encrypted sharing + import
  ├── hydration.ts    — 160 lines — restoreFolderStructure + populateUiCacheFromDrives
  ├── state.ts        — 114 lines — Bee URL, UI cache fields, drive mapping
  ├── storage.ts      — 107 lines — clearSwarmStorage + loadManifestIndex (IndexedDB)
  └── events.ts       —  87 lines — Toast event system (onSwarmEvent/emitSwarmEvent)
  
  Deleted (replaced by SwarmChannel):
  ✗ sync.ts (649)  ✗ flush.ts (788)  ✗ pending-ops-store.ts (137)
  Total removed: 3,574 lines → 1,370 lines
```
