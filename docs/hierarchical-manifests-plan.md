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

## Implementation Phases

### Phase A: Add drive manifests (additive, backward compatible)
1. Add `SwarmDriveManifest` type and `driveTopic()` to SwarmClient
2. Add `readDriveManifest()` / `updateDriveManifest()` methods
3. On doc flush: write drive manifest in addition to user manifest
4. On recovery: try reading drive manifests first, fall back to flat user manifest
5. No breaking changes — old manifests still work

### Phase B: Slim down user manifest
1. Stop writing per-doc entries to user manifest
2. User manifest only contains drive references + metadata
3. Add `version: 2` flag
4. Migration: on read, if v1 detected, write drive manifests + upgrade to v2

### Phase C: Sharing via drive feeds
1. Share a drive = share the driveId + signer address
2. Recipient reads the drive feed directly → gets doc list
3. No need for separate share manifest entries per doc

## Impact on Existing Bugs

| Bug | How hierarchical fixes it |
|-----|--------------------------|
| Doc-to-drive linking broken | Docs are INSIDE drive manifests — no need for `docToDrive` map |
| Multi-drive hydration collapses | Each drive has its own manifest with its own doc list |
| Drive dedup on import | Drive identity is by driveId + name, stored in its own feed |
| User manifest too large | Slim user manifest with just drive references |
| Stale entries after clear | Clear per-drive feed, not one giant manifest |
