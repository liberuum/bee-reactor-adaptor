# Swarm Channel Architecture — Complete Design Document

> **Status (2026-04-18):** Shipped and in production. The push/pull cycles
> described below are live. The next evolution is
> [live collaboration](./live-collaboration-design.md) — replacing the
> periodic pull timer with GSOC-triggered pulls for active documents.

## Vision

Connect runs entirely in the browser, served from Swarm itself. No servers.
The user loads the app, PGlite initializes the reactor, and the user connects
their Bee node. All data lives on Swarm — encrypted, decentralized, owned by
the user.

Connect becomes a **bridge** between the existing Switchboard ecosystem and the
decentralized Swarm network. Any remote drive from Switchboard can be
automatically mirrored to Swarm storage.

---

## The Core Insight: Two Channels, One Collection

The reactor's sync system supports **multiple remotes per collection**. Each
remote has its own channel, its own cursors, and its own push/pull state.

This means a single drive can be synced to BOTH Switchboard AND Swarm
simultaneously:

```
┌──────────────────────┐
│   Switchboard API    │  (existing centralized infrastructure)
└──────────┬───────────┘
           │ GQL Channel (pull ops)
           ▼
┌──────────────────────┐
│    PGlite (local)    │  (reactor database in browser WASM)
│                      │
│  operation_index_    │  ← all ops get a global ordinal here
│  operations          │
│                      │
│  sync_cursors:       │
│    gql remote: 42    │  ← GQL channel has synced up to ordinal 42
│    swarm remote: 38  │  ← Swarm channel has pushed up to ordinal 38
└──────────┬───────────┘
           │ Swarm Channel (push ops)
           ▼
┌──────────────────────┐
│   Bee Node → Swarm   │  (decentralized storage)
└──────────────────────┘
```

### How It Works Step by Step

1. **User adds a remote drive** (e.g., Switchboard URL)
   - SyncManager creates a GQL remote: `{ type: "gql", parameters: { url } }`
   - GQL channel pulls operations from Switchboard into PGlite
   - Drive, documents, folders all materialize in the local reactor

2. **Swarm channel detects new data**
   - The same drive's `collection_id` has a Swarm remote registered
   - Swarm channel's outbox cursor is behind the latest ordinal
   - SyncManager populates outbox with new ops since last cursor position
   - SwarmChannel pushes them: encrypt → upload /bytes → write to feed

3. **Result**: The remote drive is now stored on Swarm
   - User can disconnect from Switchboard entirely
   - On a new device, SwarmChannel pulls the drive back from Swarm
   - Full round-trip: Switchboard → PGlite → Swarm → PGlite (new device)

### The Bridge Pattern

```
  Switchboard World              User's Browser              Swarm World
  ─────────────────           ──────────────────          ─────────────────
                              ┌────────────────┐
  Remote Drive A  ──GQL──▶   │                │  ──Swarm──▶  Feed A
  Remote Drive B  ──GQL──▶   │    PGlite      │  ──Swarm──▶  Feed B
                              │   (reactor)    │
  (not connected)             │                │  ──Swarm──▶  Feed C
                              │  Local Drive C │
                              └────────────────┘
```

- **Remote drives** (A, B): pulled from Switchboard via GQL, mirrored to Swarm
- **Local drives** (C): created locally, synced only to Swarm
- **All drives**: stored encrypted on Swarm, recoverable on any device

---

## Technical Architecture

### The Reactor Sync System

The reactor has a built-in sync protocol with these components:

```
ReactorBuilder
  └─ SyncBuilder
       └─ IChannelFactory (creates channels by type)
            └─ IChannel (one per remote)
                 ├─ inbox   (IMailbox — pull ops from remote)
                 ├─ outbox  (IMailbox — push ops to remote)
                 └─ deadLetter (IMailbox — failed ops)
```

**PGlite Tables:**

| Table | Purpose |
|---|---|
| `sync_remotes` | Registered remotes: name, collection_id, channel_type, push/pull state |
| `sync_cursors` | Per-remote cursor tracking: ordinal position (inbox & outbox) |
| `sync_dead_letters` | Failed operations with error details |
| `operation_index_operations` | Global ordinal index across all operations |

**Key Types:**

```typescript
interface IChannel {
  inbox: IMailbox;          // Ops received from remote
  outbox: IMailbox;         // Ops to send to remote
  deadLetter: IMailbox;     // Failed ops
  init(): Promise<void>;
  shutdown(): Promise<void>;
  getConnectionState(): ConnectionStateSnapshot;
  onConnectionStateChange(callback): () => void;
}

interface IChannelFactory {
  instance(
    remoteId: string,
    remoteName: string,
    config: ChannelConfig,         // { type: "swarm", parameters: {...} }
    cursorStorage: ISyncCursorStorage,
    collectionId: string,
    filter: RemoteFilter,
    operationIndex: IOperationIndex,
  ): IChannel;
}

type ChannelConfig = {
  type: string;                    // "gql" | "swarm" | any string
  parameters: Record<string, unknown>;
};
```

### CompositeChannelFactory

The reactor supports ONE `IChannelFactory` per instance. To support both GQL
and Swarm channels, we create a composite factory that routes by `config.type`:

```typescript
import type { IChannel, IChannelFactory } from "@powerhousedao/reactor";
import type { ChannelConfig, RemoteFilter } from "@powerhousedao/reactor";
import type { ISyncCursorStorage } from "@powerhousedao/reactor";
import type { IOperationIndex } from "@powerhousedao/reactor";

export class CompositeChannelFactory implements IChannelFactory {
  private factories = new Map<string, IChannelFactory>();

  register(type: string, factory: IChannelFactory): void {
    this.factories.set(type, factory);
  }

  instance(
    remoteId: string,
    remoteName: string,
    config: ChannelConfig,
    cursorStorage: ISyncCursorStorage,
    collectionId: string,
    filter: RemoteFilter,
    operationIndex: IOperationIndex,
  ): IChannel {
    const factory = this.factories.get(config.type);
    if (!factory) {
      throw new Error(
        `Unknown channel type "${config.type}". ` +
        `Registered types: ${[...this.factories.keys()].join(", ")}`
      );
    }
    return factory.instance(
      remoteId, remoteName, config, cursorStorage,
      collectionId, filter, operationIndex,
    );
  }
}
```

### Wiring Into createBrowserReactor

Our fork's `createBrowserReactor()` uses the proper reactor builder API:

```typescript
import { createSwarmSyncBuilder } from "../../../adapter/src/channel/create-composite-factory.js";

// 1. Create SyncBuilder with Swarm channel registered at build time.
//    GQL is deferred — needs the queue (with document model resolver)
//    which is created inside buildModule().
const { syncBuilder, registerGqlFactory } = createSwarmSyncBuilder(logger, jwtHandler);

// 2. Wire into ReactorBuilder via withSync() — no monkey-patching
const builder = new ReactorClientBuilder()
  .withReactorBuilder(
    new ReactorBuilder()
      .withSync(syncBuilder)         // ← CompositeChannelFactory with "swarm"
      .withJwtHandler(jwtHandler)    // ← still needed for GQL auth
      ...
  );

const module = await builder.buildModule();

// 3. Register GQL factory after build (needs queue with proper resolver)
const queue = module.reactorModule?.queue;
if (queue) registerGqlFactory(queue);
```

**Why this works:** The ReactorBuilder has two code paths:
1. `if (this.channelScheme)` — auto-creates a single factory type
2. `else if (this.syncBuilder)` — uses YOUR factory

By using path 2, we get full control over which channel types are available.
Swarm remotes persist in `sync_remotes` and are recreated natively on startup.
GQL is registered after build because `GqlRequestChannelFactory` needs the
queue (for poll timer backpressure), which requires the document model resolver
created inside `buildModule()`.

No monkey-patching. No SQL hacks. No dynamic re-registration.

---

## SwarmChannel Implementation

### Push Cycle (local → Swarm)

When the reactor writes operations locally, the SyncManager:

1. Detects new ordinals in `operation_index_operations` beyond the outbox cursor
2. Groups operations by (documentId, scope, branch) into `SyncOperation` objects
3. Adds them to `SwarmChannel.outbox`
4. Our `outbox.onAdded` callback fires:

```
SyncOperation { documentId, operations: OperationWithContext[] }
  → serialize to JSON
  → encrypt with AES-256-GCM (wallet-derived key)
  → upload to /bytes endpoint on Bee node
  → write reference to document's feed (SOC)
  → update drive manifest feed
  → syncOp.executed()  // tells SyncManager we're done
  → cursor advances in sync_cursors
```

### Pull Cycle (Swarm → local)

On a new device or after reconnect:

1. SwarmChannel polls the user's feed at configured interval
2. Reads the user manifest → discovers drives and documents
3. For each document, reads the document manifest → discovers operation batches
4. Downloads batches from /bytes, decrypts, deserializes
5. Converts to `SyncOperation` objects
6. Adds to `SwarmChannel.inbox`
7. SyncManager applies them to local reactor via `reactor.load()`
8. Cursor advances — subsequent polls only fetch new operations

```
Swarm feed (document manifest)
  → read operation batch references
  → download from /bytes
  → decrypt AES-256-GCM
  → deserialize to OperationWithContext[]
  → wrap in SyncOperation
  → inbox.add(syncOp)
  → SyncManager applies to reactor
  → cursor advances in sync_cursors
```

### Connection State

Maps Bee node health to the channel's connection state:

| Bee Status | Channel State |
|---|---|
| /health returns 200 | `connected` |
| /health fails | `reconnecting` |
| Multiple failures | `error` |
| Bee URL changed | `connecting` |
| Channel shutdown | `disconnected` |

### Swarm Channel Config

```typescript
syncManager.add("swarm:" + driveId, collectionId, {
  type: "swarm",
  parameters: {
    beeUrl: "https://bee-node.example:1633",
    batchId: "60c067db7ec0...",
    feedTopicPrefix: "ph:v2",
    ownerAddress: "0xadbA7C2F...",
    pollIntervalMs: 5000,
    encryptionEnabled: true,
  }
});
```

---

## User Flows

### Flow 1: Local Drive → Swarm

1. User creates a drive in Connect
2. Plugin auto-registers Swarm remote for the drive's collection
3. Operations flow: reactor → outbox → encrypt → Bee → Swarm
4. Cursor tracks position — survives page reload

### Flow 2: Remote Drive (Switchboard) → Local → Swarm

1. User clicks "Add Remote Drive" and pastes Switchboard URL
2. SyncManager creates GQL remote → pulls drive from Switchboard
3. Operations land in PGlite with global ordinals
4. Plugin detects new drive → registers Swarm remote for same collection
5. Swarm outbox cursor picks up all operations → pushes to Swarm
6. Drive is now on BOTH Switchboard AND Swarm

### Flow 3: New Device Recovery (from Swarm)

1. User opens Connect on new device (served from Swarm)
2. Signs in with wallet → derives encryption keys
3. Plugin reads user manifest from Swarm feed
4. Registers Swarm remotes for each discovered drive
5. SwarmChannel.inbox pulls all operations from feeds
6. SyncManager applies to reactor → drive materializes in PGlite
7. Cursor is set → future syncs are incremental

### Flow 4: Offline Edits → Reconnect

1. User edits documents while Bee node is unreachable
2. Operations accumulate in PGlite (local reactor works fine)
3. SwarmChannel connection state: `error` → push blocked
4. User reconnects Bee node → state: `connected`
5. Outbox cursor catches up: all accumulated ops pushed to Swarm
6. No data loss — cursors in PGlite track exactly what was synced

---

## Key Source Files

| File | Purpose |
|---|---|
| `adapter/src/channel/swarm-channel.ts` | IChannel implementation: outbox push + inbox pull |
| `adapter/src/channel/swarm-channel-factory.ts` | IChannelFactory — creates SwarmChannel from ChannelConfig |
| `adapter/src/channel/composite-factory.ts` | Routes "gql"/"swarm" to sub-factories |
| `adapter/src/channel/create-composite-factory.ts` | createSwarmSyncBuilder() for ReactorBuilder.withSync() |
| `adapter/src/channel/manifest-manager.ts` | User + drive manifest writes |
| `adapter/src/channel/add-swarm-remote.ts` | Per-drive Swarm remote registration |
| `adapter/src/swarm-client.ts` | Bee API: upload, download, feeds, encrypt |
| `adapter/src/swarm-crypto.ts` | AES-256-GCM encryption |
| `adapter/src/wallet-signer.ts` | Key derivation from wallet signature |
| `adapter/src/stamp-manager.ts` | Postage stamp lifecycle |
| `connect/src/utils/reactor.ts` | Wires CompositeChannelFactory into createBrowserReactor |
