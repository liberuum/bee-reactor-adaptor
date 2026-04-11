# Swarm Sync Channel — Native Reactor Integration

## Vision

Connect runs entirely in the browser, served from Swarm itself. The user loads
the app, PGlite initializes the reactor, and the user connects their Bee node.
Swarm becomes a first-class sync channel — no servers, no Switchboard, no cloud.

## Discovery: The Reactor Has a Built-in Sync Protocol

The reactor's PGlite database contains three sync tables that are currently
empty in our fork (no cloud remotes configured):

| Table | Purpose |
|---|---|
| `sync_remotes` | Registered sync endpoints with channel_type, push/pull state, failure counts |
| `sync_cursors` | Ordinal-based cursor tracking per remote (inbox/outbox) |
| `sync_dead_letters` | Failed operations with error details for retry |

The system uses an `IChannelFactory` → `IChannel` pattern:

```
ReactorBuilder
  └─ SyncBuilder
       └─ IChannelFactory (one per reactor)
            └─ IChannel (one per remote)
                 ├─ inbox   (IMailbox — pull operations from remote)
                 ├─ outbox  (IMailbox — push operations to remote)
                 └─ deadLetter (IMailbox — failed operations)
```

Currently only `"gql"` channel type exists (Switchboard/Connect cloud sync).
But `channel_type` is a plain string — no enum validation. We can register
`"swarm"` as a native channel type.

## What We Get For Free

| Feature | Current custom code | Native sync channel |
|---|---|---|
| Incremental sync | Manual `syncedRevisions` Map | Cursor ordinals in `sync_cursors` (survives page reload) |
| Failed operations | Lost on retry failure | `sync_dead_letters` with error source/message |
| Push/pull state | `syncPaused` boolean | Per-remote `push_state`/`pull_state` + failure counts |
| Operation filtering | Subscribe to all, filter manually | `filter_document_ids`, `filter_scopes`, `filter_branch` |
| Reconnect recovery | Custom reconciliation | Cursor picks up exactly where it left off |
| Connection tracking | Manual `ph.swarm.status` | `IChannel.getConnectionState()` + callbacks |

## Architecture

### Current (Custom Subscriber Pipeline)

```
Reactor → subscribe({}) → sync.ts subscriber
  → scheduleSync → syncDocumentToSwarm
    → buffer ops → flushDocumentManifest (3s debounce)
      → upload /bytes → write feed
        → update drive manifest → update user manifest
```

Problems: no persistence across page reloads, manual reconciliation needed,
custom retry logic, no dead letter handling.

### Proposed (Native Sync Channel)

```
Reactor → SyncManager (built-in)
  → SwarmChannel.outbox.push(operations)
    → encrypt + upload /bytes → write feed
  → SwarmChannel.inbox.pull()
    → read feed → decrypt → return operations
  → sync_cursors tracks position (PGlite — survives reload)
  → sync_dead_letters captures failures
```

### Key Interfaces (from reactor source)

```typescript
interface IChannelFactory {
  instance(
    remoteId: string,
    remoteName: string,
    config: ChannelConfig,
    cursorStorage: ISyncCursorStorage,
    collectionId: string,
    filter: RemoteFilter,
    operationIndex: IOperationIndex,
  ): IChannel;
}

interface IChannel {
  inbox: IMailbox;       // Pull operations from Swarm
  outbox: IMailbox;      // Push operations to Swarm
  deadLetter: IMailbox;  // Failed operations
  init(): Promise<void>;
  shutdown(): Promise<void>;
  getConnectionState(): ConnectionStateSnapshot;
  onConnectionStateChange(callback: ConnectionStateChangeCallback): () => void;
}

type ChannelConfig = {
  type: string;  // "gql" | "swarm" | anything
  parameters: Record<string, unknown>;
};
```

## Implementation Plan

### Phase 1: SwarmChannel Implementation

1. **SwarmChannel** implements `IChannel`
   - `outbox.push()`: encrypt ops → upload to /bytes → write to feed
   - `inbox.pull()`: read feed → decrypt → return new ops since cursor
   - `init()`: connect to Bee, derive wallet key
   - Connection state maps to Bee node reachability

2. **SwarmChannelFactory** implements `IChannelFactory`
   - Routes `config.type === "swarm"` → SwarmChannel
   - Falls back to GQL for any other type (or throws, since we don't use GQL)

3. **Register via ReactorBuilder**
   - Our fork overrides the factory in `createBrowserReactor()`
   - Config: `{ type: "swarm", parameters: { beeUrl, batchId, feedTopicPrefix } }`

### Phase 2: Drive Registration as Sync Remote

When user creates a drive or hydrates from Swarm:
```typescript
syncManager.add("swarm:" + driveId, collectionId, {
  type: "swarm",
  parameters: { beeUrl, batchId, feedTopicPrefix, ownerAddress }
});
```

The reactor then handles:
- Push cycle: new local ops → SwarmChannel.outbox → Swarm
- Pull cycle: SwarmChannel.inbox → new remote ops → local reactor
- Cursor tracking: `sync_cursors` knows exactly where we left off
- Dead letters: failed pushes go to `sync_dead_letters` for retry

### Phase 3: Replace Custom Code

Once SwarmChannel works, we can remove:
- `sync.ts` subscriber-based pipeline
- `flush.ts` debounced manifest writes (channel handles batching)
- Manual `syncedRevisions` / `syncPaused` / `recoveringDocs` state
- Custom reconciliation logic
- `pending-ops-store.ts` (cursors in PGlite replace IndexedDB persistence)

### Phase 4: Hydration via Pull

Hydration becomes a pull operation:
- New device → connect Bee node → register Swarm remote
- `SwarmChannel.inbox.pull()` returns ALL operations from feed
- Reactor replays them locally
- Cursor is set → future pulls are incremental

## The Single Factory Constraint

The reactor supports ONE `IChannelFactory` per instance. Options:

**Option A (Recommended for our fork):** Replace the factory entirely.
We don't use GQL sync, so our fork can use `SwarmChannelFactory` directly.

**Option B (For upstream contribution):** Create a `CompositeChannelFactory`
that dispatches based on `config.type`:
```typescript
class CompositeChannelFactory implements IChannelFactory {
  private factories = new Map<string, IChannelFactory>();
  register(type: string, factory: IChannelFactory) { ... }
  instance(remoteId, remoteName, config, ...args) {
    return this.factories.get(config.type)!.instance(...);
  }
}
```

## Key Source Files (Powerhouse Monorepo)

- Sync types: `packages/reactor/src/sync/types.ts`
- Sync interfaces: `packages/reactor/src/sync/interfaces.ts`
- SyncManager: `packages/reactor/src/sync/sync-manager.ts`
- GqlRequestChannel (reference): `packages/reactor/src/sync/channels/gql-req-channel.ts`
- GqlRequestChannelFactory: `packages/reactor/src/sync/channels/gql-request-channel-factory.ts`
- ReactorBuilder: `packages/reactor/src/reactor-builder.ts` (line ~388, factory selection)
- Storage migrations: `packages/reactor/src/storage/migrations/010_create_sync_tables.ts`
- Architecture docs: `packages/reactor/docs/ARCHITECTURE.md`

## Impact

This approach aligns with the end goal: Connect served from Swarm, fully
decentralized, no servers. The Swarm sync channel makes the Bee node a
first-class citizen in the reactor's sync infrastructure — not an afterthought
bolted on via event subscribers.

~80% of our current plugin code (sync.ts, flush.ts, hydration.ts,
pending-ops-store.ts) would be replaced by the reactor's battle-tested
sync framework with proper cursor tracking, dead letter handling, and
push/pull state management.
