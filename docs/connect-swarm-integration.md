# Connect + Swarm Integration Status

**Date:** 2026-04-07  
**Status:** Core sync + recovery working. Polishing for production.

## Architecture

### Sync (Browser → Swarm)
1. SwarmConnectPlugin initializes at processor registration time
2. Subscribes to ALL reactor document change events
3. On change: reads Swarm manifest → checks `index > swarmLatest` → uploads only NEW ops to `/bytes`
4. Appends batch to document manifest feed (`ph:doc:<id>`)
5. Batched debounced user manifest feed (`ph:user:<address>`) — 1s debounce

### Recovery (Swarm → Browser)
1. On login: derive Swarm key from wallet (deterministic)
2. Read user manifest from feed → discover documents
3. Check which docs DON'T exist locally (via `getDocument` + drive `nodes` check)
4. For each missing child doc:
   - Mark as `recoveringDocs` (skip sync events to avoid feed conflicts)
   - Get default state: `reactorClient.getDocumentModelModule(type).utils.createState()`
   - Create in drive: `createDocumentInDrive(driveId, shellDoc)`
   - Replay user actions: `execute(docId, "main", globalScopeOps)`
   - Set `syncedRevisions` to local op count
   - Unmark from `recoveringDocs`

### Deletion Handling
- **Reactive:** Subscribe to `deleted` + `child_removed` events → remove from manifest immediately
- **Startup reconciliation:** Query all drives + children, diff with manifest, remove orphans

### Key Components
- **swarm-plugin.ts** — `swarm-doc-model/processors/`, all sync + hydration + deletion logic
- **swarm-storage.tsx** — `packages/connect/src/.../settings/`, Settings UI
- **SwarmClient** — `@liberuum-org/bee-reactor-adapter`, Swarm API wrapper
- **SwarmConnectPlugin** — adapter, identity + stamp monitoring

### Packages
- `@liberuum-org/bee-reactor-adapter@0.10.0`
- `@liberuum-org/connect@6.0.0-dev.157-swarm.5`

## Remaining Bugs

### High Priority
1. Sync status indicator — visual feedback for backup state
2. Duplicate recovery drives on some edge cases
3. 400 on rapid user manifest writes (occasional feed index conflicts)

### Medium Priority
4. Tree view driveId — "unlinked" in settings
5. Drive name — "Recovered Drive" instead of original
6. Settings UI scroll — needs connect republish
7. Stamp capacity shows 100%
8. Node wallet balance refresh

### Low Priority
9. Node address truncated
10. Old feed data accumulates
11. Clear storage latency

## Technical Notes

### Why `createDocumentInDrive` + `execute` for recovery?
- `createDocumentInDrive` atomically: CREATE_DOCUMENT + UPGRADE_DOCUMENT + ADD_RELATIONSHIP + ADD_FILE
- Sets proper initial state from `getDocumentModelModule(type).utils.createState()`
- UPGRADE_DOCUMENT on Swarm has EMPTY initial state — reactor fills it from the model at runtime

### Why `recoveringDocs` set?
- `createDocumentInDrive` + `execute` fire reactor events
- Without `recoveringDocs`, the sync subscription picks up these events and tries to write to the doc's feed
- But the feed already has data from the original session → 400 SOC conflict
- `recoveringDocs` tells the sync to skip these docs until recovery is complete

### Feed mode
- `useFeedMode: true` — deterministic manifests via Swarm feeds
- `deferred: false` — synchronous SOC writes (required for index consistency)
- Individual doc feeds NOT cleared on "Clear Storage" (they expire with stamp)
