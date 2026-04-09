# Hierarchical Manifests — Design Plan

## Problem

The current flat user manifest grows linearly with the number of documents. Every doc flush rewrites the ENTIRE manifest (all drives + all docs). With 100+ docs:

- User manifest JSON becomes large (10-50KB+)
- Every doc edit triggers a full manifest rewrite after debounce
- Recovery reads one giant blob and must download ALL doc manifests
- Drive-doc relationships are stored redundantly (in both `documents` and `drives`)
- No way to sync just one drive — it's all or nothing

## Current Structure (Flat)

```
User Feed: ph:v2:user:<0x_address>
  └─ SwarmUserManifest (one big JSON, rewritten on every change)
       ├─ documents: { docA: {name, type, driveId}, docB: {...}, ... }
       ├─ drives: { drive1: {name, documentIds: [...]}, drive2: {...} }
       └─ stamps: { ... }

Doc Feed: ph:v2:doc:<docId>
  └─ SwarmDocumentManifest { operationBatches, keyframes }
```

**Write cost per doc edit**: rewrite entire user manifest (all docs, all drives)
**Recovery cost**: download user manifest → download ALL doc manifests → download ALL op batches

## Proposed Structure (Hierarchical)

```
User Feed: ph:v2:user:<0x_address>
  └─ SwarmUserManifest (small, rarely changes)
       ├─ drives: {
       │    drive1: { name, driveId, docCount, lastUpdated },
       │    drive2: { name, driveId, docCount, lastUpdated },
       │  }
       ├─ shares: { ... }  (sharing metadata)
       └─ version: 2  (for backward compatibility detection)

Drive Feed: ph:v2:drive:<driveId>  (NEW — one feed per drive)
  └─ SwarmDriveManifest (medium, changes when docs in this drive change)
       ├─ driveId, name
       ├─ documents: {
       │    docA: { name, type, lastUpdated },
       │    docB: { name, type, lastUpdated },
       │  }
       └─ updatedAt

Doc Feed: ph:v2:doc:<docId>  (unchanged)
  └─ SwarmDocumentManifest { operationBatches, keyframes }
```

## Benefits

### 1. Smaller Writes
- Editing a doc in drive1 only rewrites the drive1 manifest (~1-5KB) instead of the entire user manifest (~10-50KB)
- User manifest only changes when drives are added/removed (rare)

### 2. Drive Isolation
- Each drive has its own feed → drives are independent
- Corrupt/stale data in one drive doesn't affect others
- Recovery can be per-drive (only recover what changed)

### 3. Natural Drive-Doc Linking
- Documents are listed INSIDE their drive manifest → no more broken links
- No need for `docToDrive` map or `lastSeenDriveId` fallback
- The `findParentDrive` problem goes away entirely

### 4. Sharing Maps Cleanly
- Share a drive = share a reference to the drive feed
- Recipient reads the drive manifest → gets all docs
- No need to enumerate docs in the share manifest

### 5. Incremental Recovery
- User manifest lists drives with `lastUpdated` timestamps
- Only download drive manifests that changed since last sync
- Each drive manifest lists docs — only download changed docs

## Feed Topics

| Feed | Topic | Owner | Content |
|------|-------|-------|---------|
| User manifest | `ph:v2:user:<0x_address>` | signer | Drives list + sharing metadata |
| Drive manifest | `ph:v2:drive:<driveId>` | signer | Documents in this drive |
| Doc manifest | `ph:v2:doc:<docId>` | signer | Operation batches + keyframes |
| Public profile | `ph:v2:profile:<0x_address>` | signer | Bee node pubkey (unchanged) |
| Share manifest | `ph:v2:share:<sender>:<recipient>` | sender | Shared doc/drive references |

## Write Flow (After Change)

### Current: Edit doc in drive1
```
1. Upload ops to /bytes
2. Write doc manifest to ph:v2:doc:<docId>
3. Rewrite ENTIRE user manifest to ph:v2:user:<address>  ← expensive!
```

### Proposed: Edit doc in drive1
```
1. Upload ops to /bytes
2. Write doc manifest to ph:v2:doc:<docId>  (unchanged)
3. Write drive1 manifest to ph:v2:drive:<drive1Id>  ← only this drive
4. (optionally) Update user manifest if drive metadata changed  ← rare
```

### Feed Writes Per Operation

| Scenario | Current | Hierarchical |
|----------|---------|-------------|
| Edit 1 doc | 2 feeds (doc + user) | 2 feeds (doc + drive) |
| Edit 5 docs in 1 drive | 2 feeds (doc×5 debounced to 1 + user) | 2 feeds (doc×5 debounced to 1 + drive) |
| Edit 5 docs in 5 drives | 6 feeds (5 docs + 1 user) | 10 feeds (5 docs + 5 drives) |
| Add new drive | 1 feed (user) | 2 feeds (drive + user) |

**Trade-off**: Editing across many drives is slightly MORE feed writes, but each write is smaller. Editing within one drive is the same or cheaper.

## Recovery Flow (After Change)

### Current
```
1. Read user manifest (1 feed read)
2. For each doc in manifest:
   a. Read doc manifest (1 feed read per doc)
   b. Download all op batches (N /bytes downloads per doc)
3. Replay all ops
```
For 5 drives × 20 docs: 1 + 100 feed reads + N×100 downloads

### Proposed
```
1. Read user manifest (1 feed read) → get drive list
2. For each drive:
   a. Read drive manifest (1 feed read per drive)
   b. For each doc in drive:
      - Read doc manifest (1 feed read per doc)
      - Download op batches (N /bytes downloads per doc)
3. Replay ops, organized by drive
```
For 5 drives × 20 docs: 1 + 5 + 100 feed reads + N×100 downloads

Same total reads, BUT:
- Drives are naturally grouped → no more `docToDrive` resolution
- Can skip unchanged drives (incremental recovery)
- Each drive can be recovered independently

## Backward Compatibility

The user manifest gains a `version` field:
- `version: undefined` or `version: 1` → old flat format, read as before
- `version: 2` → hierarchical format, drives have references not document lists

On first write with new code, migrate:
1. Read old flat manifest
2. For each drive: create a SwarmDriveManifest and write to its feed
3. Write new slim user manifest with `version: 2`

Old clients reading a v2 manifest see drives but no documents → graceful degradation.

## New Types

```typescript
/** v2 user manifest — slim, only lists drives */
interface SwarmUserManifestV2 {
  version: 2;
  address: string;
  beeNodePublicKey?: string;
  drives: Record<string, UserDriveEntryV2>;
  shares?: Record<string, ShareReference>;
  stamps: Record<string, UserStampEntry>;
  updatedAt: string;
}

interface UserDriveEntryV2 {
  name: string;
  docCount: number;
  lastUpdated: string;
}

/** NEW: per-drive manifest stored on its own feed */
interface SwarmDriveManifest {
  driveId: string;
  name: string;
  documents: Record<string, DriveDocumentEntry>;
  updatedAt: string;
}

interface DriveDocumentEntry {
  documentType: string;
  name: string;
  lastUpdated: string;
}
```

## Implementation Status

### Phase A: Drive manifests — DONE (April 9)
- `SwarmDriveManifest` type + `driveTopic()` in SwarmClient
- `readDriveManifest()` / `updateDriveManifest()` methods
- Doc flush writes drive manifest alongside doc manifest (debounced per drive)
- Recovery reads drive manifests first, falls back to flat user manifest (v1 compat)

### Phase B: Slim user manifest — DONE (April 9)
- User manifest writes drives only (name, lastUpdated), no per-doc entries
- Recovery uses drive manifests as sole source of truth for doc grouping
- UI cache populated from drive manifests for Settings tree view

### Phase C: Drive-bundle sharing — DONE (April 9)
- Share groups docs by drive, uploads ONE encrypted bundle per drive
- Import downloads one bundle per drive, unpacks and creates each doc
- Single doc or full drive sharing both work through the same mechanism

## Impact on Existing Bugs

| Bug | Fixed? | How |
|-----|--------|-----|
| Doc-to-drive linking broken | **FIXED** | Docs are INSIDE drive manifests — verified with multi-doc drives |
| Multi-drive hydration collapses | **FIXED** | Each drive has its own feed — verified with 2-drive recovery |
| Drive dedup on import | **FIXED** | sessionStorage + drive name matching |
| User manifest too large | **FIXED** | Slim manifest with just drive references |
| Stale entries after clear | **FIXED** | Clear per-drive feed, user manifest keeps identity |
| Swarm propagation delays | **FIXED** | Import retries 3 times with backoff (0s, 3s, 8s) |

## Clear Storage Behavior

"Clear Swarm Storage" should be surgical — reset data, keep identity:

```
KEEP (user identity):
  ├─ address
  ├─ beeNodePublicKey
  ├─ stamps info
  ├─ version
  └─ profile feed (public identity — don't touch)

CLEAR (user data):
  ├─ user manifest: drives → {}, shares → {}
  ├─ each drive feed: write empty { driveId, name, documents: {} }
  └─ local PGlite: separate "Danger Zone" action (not part of Swarm clear)

LEAVE ALONE (expire naturally with stamp):
  ├─ doc feeds (operation batches)
  ├─ share feeds
  └─ /bytes data (content-addressed, immutable)
```

### Why Keep Identity?

- No wallet re-signing needed after clear
- Stamp monitoring continues (TTL alerts still work)
- Public profile stays discoverable (other users can still look you up)
- Fresh sync from local PGlite will re-populate drives

### Why NOT Delete Doc Feeds?

- Doc feeds are write-once-per-index — can't "delete" a SOC, only stop writing
- Old SOCs expire when the postage stamp runs out (natural cleanup)
- Clearing the drive manifest effectively "unlinks" docs — they become unreachable
- If user re-syncs the same docs, new op batches are uploaded (old ones orphaned but harmless)

### Implementation

```typescript
async function clearSwarmStorage(client: SwarmClient, address: string): Promise<void> {
  // 1. Read current user manifest to get drive list
  const manifest = await client.readUserManifest(address);
  
  // 2. Clear each drive manifest feed
  if (manifest?.drives) {
    for (const driveId of Object.keys(manifest.drives)) {
      await client.updateDriveManifest(driveId, {
        driveId, name: "", documents: {}, updatedAt: new Date().toISOString(),
      });
    }
  }
  
  // 3. Write slim user manifest (keep identity, clear data)
  await client.updateUserManifest(address, {
    version: 2,
    address: manifest?.address ?? address,
    beeNodePublicKey: manifest?.beeNodePublicKey,
    drives: {},
    shares: {},
    stamps: manifest?.stamps ?? {},
    updatedAt: new Date().toISOString(),
  });
}
```
