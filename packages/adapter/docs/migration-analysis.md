# Migration Analysis: Custom Plugin → Native SwarmChannel

## Summary

Moving from the current subscriber-based plugin to a native reactor sync channel
(IChannel) eliminates ~2,500 lines and simplifies the architecture dramatically.

**Current:** 7,142 lines across 21 files
**After migration:** ~4,000 lines across ~16 files (+ ~500 new SwarmChannel code)
**Net reduction:** ~2,600 lines removed, architecture fundamentally simpler

---

## File-by-File Classification

### REMOVE — Replaced entirely by SwarmChannel/SyncManager (~2,150 lines)

| File | Lines | Why it goes |
|------|-------|-------------|
| `plugin/sync.ts` | 649 | Reactor subscriber pattern replaced by SyncManager's outbox push cycle |
| `plugin/state.ts` | 278 | Plugin-specific state (syncPaused, syncedRevisions, pendingOps, flush timers). SyncManager tracks cursors in PGlite; SwarmChannel manages its own state |
| `bee-reactor-adapter.ts` | 181 | Adapter pattern obsolete — SwarmChannel registers directly with reactor |
| `connect-plugin.ts` | 290 | Orchestrator class redundant — wallet-signer + SwarmChannelFactory + init helper replaces it |
| `plugin/flush.ts` (partial) | ~750 | Three flush pipelines (doc manifest, user manifest, drive manifest) replaced by SwarmChannel outbox. Some debounce/batch logic reused inside channel |

### KEEP — Still needed, no changes (~2,170 lines)

| File | Lines | Why it stays |
|------|-------|-------------|
| `wallet-signer.ts` | 243 | Core identity derivation — same wallet = same key, independent of sync arch |
| `swarm-crypto.ts` | 125 | AES-256-GCM encryption — pure utility, used by channel and sharing |
| `stamp-manager.ts` | 295 | Postage stamp lifecycle — consumed by SwarmChannel and Settings UI |
| `share-manager.ts` | 134 | Cross-user sharing API — orthogonal to sync architecture |
| `plugin/sharing.ts` | 418 | Sharing orchestration — keeps working with SwarmClient reference |
| `folder-tree.ts` | 43 | Pure recursive tree builder — used by hydration and UI |
| `swarm-operation-store.ts` | 363 | IOperationStore interface — reactor integration contract |
| `swarm-keyframe-store.ts` | 189 | IKeyframeStore interface — reactor integration contract |
| `plugin/pending-ops-store.ts` | 137 | IndexedDB resilience — pattern reused inside SwarmChannel |
| `types.ts` | 316 | Type definitions — keep + minor refactor to separate manifest types |

### REUSE-IN-CHANNEL — Logic moves into SwarmChannel (~1,280 lines → ~400 new)

| File | Lines | What moves |
|------|-------|------------|
| `swarm-client.ts` | 750 | **KEEP as transport layer**. Manifest read/write logic moves to SwarmChannel. SwarmClient becomes pure Bee API: upload/download bytes, read/write feeds, encrypt/decrypt |
| `swarm-sync-read-model.ts` | 307 | Upload-on-index pattern + per-doc write locks → SwarmChannel outbox handler |
| `swarm-hydrator.ts` | 219 | Recovery orchestration → SwarmChannel inbox pull cycle |
| `plugin/hydration.ts` | 656 | `restoreFolderStructure()` stays (shared with sharing). Recovery loop → SwarmChannel.inbox pull. `populateUiCacheFromDrives()` → app-level concern |
| `plugin/events.ts` | 94 | Event pattern → SwarmChannel uses IChannel.onConnectionStateChange + custom events for UI |

### SIMPLIFY — Keeps some parts, loses others

| File | Lines | What changes |
|------|-------|-------------|
| `plugin/init.ts` | 552 | Remove processor builder pattern, monolithic orchestrator. Keep: Bee health check, stamp auto-selection. Becomes a thin init helper (~100 lines) |

---

## What SwarmChannel Replaces (Visually)

```
BEFORE (Custom Plugin)                    AFTER (Native SwarmChannel)
═══════════════════════                   ═══════════════════════════

reactor.subscribe({})                     SyncManager (built-in)
       │                                         │
  sync.ts (649 lines)                    SwarmChannel.outbox.onAdded()
  ├─ scheduleSync()                       ├─ serialize ops
  ├─ syncDocumentToSwarm()                ├─ encrypt (swarm-crypto)
  ├─ bufferOps → pendingOps               ├─ upload /bytes (swarm-client)
  └─ reconcileUserManifest()              └─ write feed (swarm-client)
       │                                         │
  flush.ts (788 lines)                   SwarmChannel internal state
  ├─ 3s debounce timer                    ├─ BufferedMailbox (500ms batch)
  ├─ flushDocumentManifest()              ├─ cursor in sync_cursors (PGlite)
  ├─ updateUserManifest()                 └─ dead letters in sync_dead_letters
  ├─ flushDriveManifest()
  └─ MAX_CONCURRENT_FLUSHES
       │                                         │
  state.ts (278 lines)                   SyncManager state (PGlite)
  ├─ syncPaused                           ├─ sync_cursors.cursor_ordinal
  ├─ syncedRevisions Map                  ├─ sync_remotes.push_state
  ├─ pendingManifests Map                 ├─ sync_remotes.pull_state
  ├─ recoveringDocs Set                   └─ sync_dead_letters
  └─ docToDrive Map
       │                                         │
  hydration.ts (656 lines)               SwarmChannel.inbox (pull cycle)
  ├─ hydrateFromSwarm()                   ├─ read feeds
  ├─ downloadOperations()                 ├─ decrypt + deserialize
  ├─ createDrive + syncPaused             ├─ inbox.add(syncOps)
  └─ restoreFolderStructure()             └─ SyncManager applies to reactor
       │                                         │
  pending-ops-store.ts (137 lines)       sync_cursors (PGlite)
  ├─ IndexedDB persistence                ├─ cursor survives page reload
  └─ replay on startup                    └─ no separate persistence needed
       │                                         │
  init.ts (552 lines)                    createBrowserReactor() + init helper
  ├─ initSwarmPlugin()                    ├─ createSwarmSyncBuilder() → withSync()
  ├─ waitForBeeNode()                     ├─ CompositeChannelFactory (GQL + Swarm)
  └─ fetchUsableStamp()                   └─ Swarm remotes persist natively
```

---

## What's Fundamentally Better

### 1. Persistence Across Page Reloads
**Before:** Custom `syncedRevisions` Map in memory → lost on reload. Workaround: `pending-ops-store.ts` in IndexedDB.
**After:** `sync_cursors` in PGlite → survives reload natively. No workaround needed.

### 2. No More syncPaused/recoveringDocs Guards
**Before:** Manual `syncPaused = true` during hydration to prevent re-upload race. Complex `recoveringDocs` Set to skip individual docs.
**After:** SyncManager handles this. Inbox operations are applied before outbox pushes. Cursor-based — no race possible.

### 3. No More Manual Reconciliation
**Before:** `reconcileUserManifest()` reads all reactor state and diffs against Swarm. Runs on startup, error-prone.
**After:** Cursor picks up exactly where it left off. If cursor is behind, SyncManager populates outbox. Automatic.

### 4. Dead Letter Handling
**Before:** Failed flushes retry 3 times, then silently give up. Ops may be lost.
**After:** Failed operations go to `sync_dead_letters` table. Persisted. Queryable. Retryable.

### 5. Dual Channel Support
**Before:** Only Swarm sync (custom). Adding GQL sync would require a second parallel system.
**After:** CompositeChannelFactory routes `"gql"` and `"swarm"` to different channels. Same drive can sync to both. Bridge pattern: Switchboard → PGlite → Swarm.

### 6. Connection State Management
**Before:** Manual `ph.swarm.status` with string constants. No standardized state machine.
**After:** `IChannel.getConnectionState()` returns `ConnectionStateSnapshot` with `state`, `failureCount`, `pushBlocked`, etc. Standard reactor contract.

---

## New Files to Create (~500 lines total)

| File | Est. Lines | Purpose |
|------|-----------|---------|
| `channel/swarm-channel.ts` | ~300 | IChannel implementation — outbox push, inbox pull, connection state |
| `channel/swarm-channel-factory.ts` | ~60 | IChannelFactory — creates SwarmChannel from ChannelConfig |
| `channel/composite-factory.ts` | ~30 | Routes config.type to appropriate factory |
| `channel/swarm-manifest-service.ts` | ~80 | User/drive manifest management (app-level, not channel primitive) |
| Modified `utils/reactor.ts` | ~20 | Wire CompositeChannelFactory into createBrowserReactor |

---

## Migration Sequence

### Step 1: Foundation (non-breaking)
- Create `channel/composite-factory.ts`
- Create `channel/swarm-channel-factory.ts` (stub)
- Create `channel/swarm-channel.ts` (IChannel skeleton)
- Modify `createBrowserReactor()` to use CompositeChannelFactory

### Step 2: Outbox (push — replaces sync.ts + flush.ts)
- Implement `outbox.onAdded()` → serialize → encrypt → upload → feed write
- SwarmChannel manages its own manifest updates
- Test: create doc locally → verify it appears on Swarm

### Step 3: Inbox (pull — replaces hydration.ts)
- Implement poll cycle → read feeds → decrypt → deserialize → inbox.add()
- SyncManager applies ops to reactor
- Test: fresh PGlite → verify drive recovered from Swarm

### Step 4: Connection State + Events
- Map Bee node health to ConnectionStateSnapshot
- Wire up UI notifications via onConnectionStateChange

### Step 5: Bridge (GQL + Swarm dual sync)
- Register Swarm remote for drives pulled via GQL
- Test: add Switchboard drive → verify it appears on Swarm

### Step 6: Cleanup
- Remove: sync.ts, flush.ts (most), state.ts, init.ts (most), connect-plugin.ts, bee-reactor-adapter.ts
- Update imports across codebase
- Update tests
