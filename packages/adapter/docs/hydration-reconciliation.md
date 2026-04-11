# Hydration Robustness & Reconciliation

## Problem Statement

The Swarm Connect plugin syncs documents between the local browser reactor (PGlite/WASM) and the Swarm decentralized network. The local reactor state is ephemeral — PGlite runs in-memory during development and can be wiped by clearing browser data, switching devices, or simply refreshing the page in dev mode.

The current hydration (recovery from Swarm) works but has several fragility issues that surface under real-world conditions:

### 1. Duplicate Drives on Page Refresh

**What happens:** Every page refresh wipes PGlite (in dev mode). Hydration sees "no local drives" and creates new ones from Swarm data. But the sync subscriber fires immediately when the new drives are created, treating them as NEW drives and syncing them back to Swarm with new IDs. Result: the Swarm manifest accumulates duplicate drive entries.

**Root cause:** The `localStorage` drive mapping (`swarm:driveMap`) persists across refreshes, but if the mapping points to a local drive ID that no longer exists in PGlite, it's stale. The current code detects stale mappings and removes them, but then creates a NEW local drive with a NEW ID — and the sync subscriber picks it up before hydration can write the clean manifest.

**Impact:** Users see multiple copies of the same drive. The Swarm manifest grows with orphaned entries.

### 2. Race Between Hydration and Sync

**What happens:** Hydration runs with `syncPaused = true`, but sync resumes the instant hydration completes (`finally { syncPaused = false }`). At that exact moment, the reactor fires change events for all the drives and documents that hydration just created. The sync subscriber processes these as "new" changes and uploads them — even though they already exist on Swarm.

**Root cause:** There's no reconciliation step between "hydration just restored this doc from Swarm" and "sync sees a new doc in the reactor." The `recoveringDocs` set tracks in-flight recoveries, but it's cleared after each doc is created, before the sync subscriber processes the batch.

**Impact:** Unnecessary Swarm uploads (wasted stamp capacity), potential manifest corruption from concurrent writes to the same feed.

### 3. No Full Reconciliation After Reconnect

**What happens:** After login, the plugin reads the Swarm manifest and hydrates any missing drives/docs. But if the user already has some drives locally (from a previous session that partially synced), the plugin doesn't cross-check whether every document in every local drive is also on Swarm. Documents created while offline (or during a failed sync) are silently lost.

**Root cause:** The current approach is purely event-driven — it only syncs documents when the reactor emits a change event. There's no periodic or startup reconciliation that compares the full local state against the full Swarm state.

**Impact:** Data loss for documents created during network outages or partial sync failures.

### 4. Folder Structure Lost During Hydration

**What happens:** Hydration creates documents at the drive root via `createDocumentInDrive`, then issues `MOVE_NODE` actions to place them in folders. But `MOVE_NODE` uses `{ srcFolder: docId, targetParentFolder: folderId }` which moves a node from its current parent to a new one. If the document was just created at root and the folder doesn't exist yet (race condition), the move fails silently.

**Root cause:** The folder restoration happens as a separate step after all documents are created, but the reactor may not have finished processing the `ADD_FOLDER` actions before the `MOVE_NODE` actions execute.

**Impact:** Documents appear at the drive root instead of their correct folder position.

---

## Proposed Architecture

### Phase 1: Sequential Batch Hydration

Replace the current "create one at a time with delays" approach with a deterministic sequential pipeline:

```
For each Swarm drive:
  1. CREATE the local drive
     → await reactorClient.addDrive(...)
     → verify: await reactorClient.get(localDriveId)
     → register drive mapping (localStorage)

  2. BATCH all folder actions (topologically sorted)
     → await reactorClient.execute(driveId, "main", folderActions)
     → verify: read drive state, confirm all folders exist

  3. For each document in the drive:
     a. Create shell document in drive WITH parentFolder
        → use ADD_FILE action with { id, name, documentType, parentFolder }
        → NOT createDocumentInDrive (which places at root)
     b. Download operations from Swarm
     c. Replay operations
        → await reactorClient.execute(docId, "main", userOps)

  4. Mark ALL created doc IDs in recoveringDocs set
     → keep them there until sync is fully ready

  5. Write clean manifest to Swarm
     → canonical source of truth, overwrites any stale data
```

**Key difference:** Each step VERIFIES completion before moving to the next. No fire-and-forget, no timing-based delays.

### Phase 2: Sync Pause Window

After hydration completes, don't immediately resume sync. Instead:

```
1. Hydration complete → syncPaused stays TRUE
2. Wait 2 seconds for reactor to settle (process all queued events)
3. Take a snapshot of all local drive/doc IDs that were just hydrated
4. Resume sync (syncPaused = false)
5. For the next 5 seconds, the sync subscriber IGNORES change events
   for any ID in the hydrated snapshot
6. After the window expires, sync processes normally
```

This prevents the "hydration creates docs → sync re-uploads them" race.

### Phase 3: Full Reconciliation

Add a reconciliation step that runs:
- Once on startup (after hydration, before normal sync begins)
- Periodically (every 5 minutes during active use)
- On reconnect (after network recovery or Bee URL change)

The reconciliation algorithm:

```
1. READ local state:
   - Get all local drives from reactor
   - For each drive, read state.global.nodes (all folders + files)
   - Build: localDocs = Map<docId, { driveId, name, docType, revision }>

2. READ Swarm state:
   - Read user manifest from Swarm
   - For each drive in manifest, read drive manifest
   - Build: swarmDocs = Map<docId, { driveId, name, docType, latestRevision }>

3. COMPARE:
   a. Missing from Swarm (local only):
      → Schedule sync for these docs (they were created offline or sync failed)
      → Log: "[SwarmPlugin] Reconciliation: syncing {count} local-only docs"

   b. Missing from local (Swarm only):
      → These need hydration (user deleted local data or new device)
      → Run hydration for these specific docs only
      → Log: "[SwarmPlugin] Reconciliation: recovering {count} Swarm-only docs"

   c. Present in both but revision mismatch:
      → If local revision > Swarm revision: sync local → Swarm
      → If Swarm revision > local revision: download new ops from Swarm
      → Log: "[SwarmPlugin] Reconciliation: {count} docs with revision mismatch"

   d. Drive structure mismatch:
      → Folders exist on Swarm but not locally (or vice versa)
      → Rebuild folder structure from the authoritative source

4. After reconciliation, write a clean user manifest to Swarm
   that reflects the merged state
```

### Phase 4: Conflict Resolution Policy

When the same document has been modified both locally and on Swarm (e.g., two devices editing simultaneously before multi-user sync is implemented):

- **Current approach (single user):** Local always wins. The user's most recent edits take priority.
- **Future approach (multi-user via SwarmChannel):** Operation-based CRDT merge. Both sets of operations are applied in causal order.

For now, the reconciliation uses "last-writer-wins" based on the `updatedAt` timestamp in the manifests.

---

## Implementation Priority

| Phase | Effort | Impact | When |
|-------|--------|--------|------|
| Phase 1: Sequential batch hydration | Medium | High — eliminates duplicate drives | Next session |
| Phase 2: Sync pause window | Low | High — eliminates unnecessary re-uploads | Next session |
| Phase 3: Full reconciliation | Medium | Critical — prevents data loss | Next session |
| Phase 4: Conflict resolution | Low (for single-user) | Medium — clean merge behavior | After Phase 3 |

---

## Test Plan

### Unit Tests (no Bee node)
- Reconciliation diff algorithm: given local state A and Swarm state B, verify correct categorization (local-only, Swarm-only, revision mismatch)
- Topological sort with various folder tree shapes (deep nesting, parallel branches, cycles)
- Sync pause window: verify events during window are buffered, not dropped

### Integration Tests (live Bee node)
- Full hydration round-trip: create drive → sync to Swarm → wipe local → hydrate → verify exact match
- Reconciliation: create docs locally → simulate partial sync failure → run reconciliation → verify all docs on Swarm
- Concurrent modification: write from two clients → reconcile → verify no data loss
- Folder preservation: nested 4-level folder tree → hydrate → verify exact folder structure restored

### Browser Tests (manual)
- Create drive with nested folders + docs → refresh page → verify single drive with correct structure
- Create docs offline (Bee node down) → reconnect → verify sync catches up
- Clear Swarm storage → verify local state is preserved → re-sync
- Import shared documents → verify folder structure matches sender's

---

## Relationship to Multi-User Sync

The reconciliation architecture is a stepping stone to the SwarmChannel (multi-user collaboration). The single-user reconciliation handles the "same user, different devices" case. The SwarmChannel extends this to "different users, same document" using:

- PSS (Postal Service over Swarm) for real-time notifications
- GSOC (Graffiti Single Owner Chunk) for lightweight event channels
- Feed-based operation logs (already implemented) as the sync protocol

The reconciliation diff algorithm (Phase 3, step 3) is the same algorithm that SwarmChannel will use to merge operations from multiple users — just with a different conflict resolution policy (CRDT merge instead of last-writer-wins).
