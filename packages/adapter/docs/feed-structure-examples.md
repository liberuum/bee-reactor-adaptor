# Swarm Feed Structure Examples

How document operations are stored on Swarm — single-user mode vs collaborative mode.

---

## Single-User: Feed Structure

When Alice creates a drive with 2 documents, this is what exists on Swarm:

```
ALICE'S SWARM FEEDS (all owned by Alice's signer address)
═══════════════════════════════════════════════════════════

1. USER MANIFEST FEED
   Topic: ph:v2:user:0xalice
   Owner: 0xAlice_signer

   Feed Index 0 → ref:aaa111 → /bytes → encrypted JSON:
   {
     "address": "0xAlice",
     "drives": {
       "drive-abc": {
         "name": "Finance Drive",
         "documentIds": [],
         "lastUpdated": "2026-04-10T12:00:00Z"
       }
     },
     "stamps": {},
     "documents": {},
     "updatedAt": "2026-04-10T12:00:00Z"
   }


2. DRIVE MANIFEST FEED
   Topic: ph:v2:drive:drive-abc
   Owner: 0xAlice_signer

   Feed Index 0 → ref:bbb222 → /bytes → encrypted JSON:
   {
     "driveId": "drive-abc",
     "name": "Finance Drive",
     "documents": {
       "doc-001": {
         "documentType": "powerhouse/budget-statement",
         "name": "Q1 Budget",
         "parentFolder": "folder-reports",
         "lastUpdated": "2026-04-10T12:01:00Z"
       },
       "doc-002": {
         "documentType": "powerhouse/invoice",
         "name": "Invoice #42",
         "lastUpdated": "2026-04-10T12:02:00Z"
       }
     },
     "folders": {
       "folder-reports": { "name": "Reports" }
     },
     "updatedAt": "2026-04-10T12:02:00Z"
   }


3. DOCUMENT MANIFEST FEED (one per document)
   Topic: ph:v2:doc:doc-001
   Owner: 0xAlice_signer

   Feed Index 0 → ref:ccc333 → /bytes → encrypted JSON:
   {
     "documentId": "doc-001",
     "documentType": "powerhouse/budget-statement",
     "latestRevision": { "global": 12 },
     "operationBatches": [
       {
         "reference": "ddd444...",
         "scope": "global",
         "branch": "main",
         "startIndex": 0,
         "endIndex": 5,
         "timestamp": "2026-04-10T12:01:00Z"
       },
       {
         "reference": "eee555...",
         "scope": "global",
         "branch": "main",
         "startIndex": 6,
         "endIndex": 12,
         "timestamp": "2026-04-10T12:03:00Z"
       }
     ],
     "keyframes": [],
     "updatedAt": "2026-04-10T12:03:00Z"
   }


4. OPERATION BATCH (on /bytes, not a feed — immutable, content-addressed)
   Reference: ddd444...
   Content (encrypted, then uploaded):
   [
     {
       "id": "op-aaa",
       "index": 0,
       "skip": 0,
       "timestampUtcMs": "1712750460000",
       "hash": "abc123...",
       "action": {
         "id": "act-001",
         "type": "CREATE_BUDGET",
         "timestampUtcMs": "1712750460000",
         "input": { "name": "Q1 Budget", "year": 2026 },
         "scope": "global",
         "context": {
           "signer": {
             "user": { "address": "0xAlice", "networkId": "1" },
             "app": { "name": "connect", "key": "..." }
           }
         }
       }
     },
     {
       "id": "op-bbb",
       "index": 1,
       "skip": 0,
       "timestampUtcMs": "1712750461000",
       "hash": "def456...",
       "action": {
         "id": "act-002",
         "type": "ADD_LINE_ITEM",
         "timestampUtcMs": "1712750461000",
         "input": { "category": "Engineering", "amount": 50000 },
         "scope": "global"
       }
     }
   ]


TOTAL FEEDS PER USER:
  1 user manifest feed
  + 1 drive manifest feed per drive
  + 1 document manifest feed per document
  = 1 + 1 + 2 = 4 feeds for this example

TOTAL /bytes UPLOADS:
  Each feed index points to 1 /bytes upload (the manifest JSON)
  + 1 /bytes upload per operation batch
  = 4 manifest uploads + 2 op batch uploads = 6 /bytes refs
```

---

## Collaborative: Two-User Feed Structure

When Alice shares `doc-001` with Bob for live collaboration:

```
SWARM FEEDS FOR COLLABORATIVE doc-001
═══════════════════════════════════════════════════════════════

EXISTING (from single-user mode — still there):
  ph:v2:user:0xalice         Alice's user manifest
  ph:v2:drive:drive-abc      Alice's drive manifest
  ph:v2:doc:doc-001          Alice's document manifest (her own backup)

NEW FEEDS FOR COLLABORATION:

5. COLLABORATION INDEX FEED (created by Alice when she shares)
   Topic: ph:v2:collab:doc-001
   Owner: 0xAlice_signer

   Feed Index 0 → ref:fff666 → /bytes → encrypted JSON:
   {
     "docId": "doc-001",
     "documentType": "powerhouse/budget-statement",
     "name": "Q1 Budget",
     "createdBy": "0xAlice_signer",
     "collaborators": [
       {
         "address": "0xAlice_signer",
         "opFeedTopic": "ph:v2:ops:0xalice_signer:doc-001",
         "joinedAt": "2026-04-10T12:00:00Z"
       },
       {
         "address": "0xBob_signer",
         "opFeedTopic": "ph:v2:ops:0xbob_signer:doc-001",
         "joinedAt": "2026-04-10T14:00:00Z"
       }
     ],
     "updatedAt": "2026-04-10T14:00:00Z"
   }


6. ALICE'S OPERATION FEED (Alice writes here, Bob reads)
   Topic: ph:v2:ops:0xalice_signer:doc-001
   Owner: 0xAlice_signer

   Feed Index 0 → ref:ggg777 → /bytes → encrypted JSON:
   {
     "type": "operations",
     "channelMeta": { "source": "0xAlice_signer" },
     "operations": [
       {
         "operation": {
           "id": "op-aaa",
           "index": 0,
           "skip": 0,
           "timestampUtcMs": "1712750460000",
           "hash": "abc123...",
           "action": {
             "id": "act-001",
             "type": "ADD_LINE_ITEM",
             "timestampUtcMs": "1712750460000",
             "input": { "category": "Engineering", "amount": 50000 },
             "scope": "global"
           }
         },
         "context": {
           "documentId": "doc-001",
           "documentType": "powerhouse/budget-statement",
           "scope": "global",
           "branch": "main",
           "ordinal": 1
         }
       },
       {
         "operation": {
           "id": "op-bbb",
           "index": 1,
           "skip": 0,
           "timestampUtcMs": "1712750465000",
           "hash": "def456...",
           "action": {
             "id": "act-002",
             "type": "SET_CELL",
             "timestampUtcMs": "1712750465000",
             "input": { "cell": "B3", "value": "75000" },
             "scope": "global"
           }
         },
         "context": {
           "documentId": "doc-001",
           "documentType": "powerhouse/budget-statement",
           "scope": "global",
           "branch": "main",
           "ordinal": 2
         }
       }
     ]
   }

   Feed Index 1 → ref:hhh888 → /bytes → encrypted JSON:
   (next batch of Alice's operations, after debounce)


7. BOB'S OPERATION FEED (Bob writes here, Alice reads)
   Topic: ph:v2:ops:0xbob_signer:doc-001
   Owner: 0xBob_signer

   Feed Index 0 → ref:iii999 → /bytes → encrypted JSON:
   {
     "type": "operations",
     "channelMeta": { "source": "0xBob_signer" },
     "operations": [
       {
         "operation": {
           "id": "op-ccc",
           "index": 0,
           "skip": 0,
           "timestampUtcMs": "1712750470000",
           "hash": "ghi789...",
           "action": {
             "id": "act-003",
             "type": "ADD_LINE_ITEM",
             "timestampUtcMs": "1712750470000",
             "input": { "category": "Design", "amount": 30000 },
             "scope": "global"
           }
         },
         "context": {
           "documentId": "doc-001",
           "documentType": "powerhouse/budget-statement",
           "scope": "global",
           "branch": "main",
           "ordinal": 1
         }
       }
     ]
   }

   Feed Index 1 → ref:jjj000 → /bytes → encrypted JSON:
   (next batch of Bob's operations)
```

---

## Side-by-Side Comparison

```
SINGLE USER                          COLLABORATIVE (2 users)
════════════                         ═══════════════════════

Feeds owned by Alice:                Feeds owned by Alice:
  ph:v2:user:0xalice                   ph:v2:user:0xalice
  ph:v2:drive:drive-abc                ph:v2:drive:drive-abc
  ph:v2:doc:doc-001                    ph:v2:doc:doc-001
                                       ph:v2:collab:doc-001         ← NEW
                                       ph:v2:ops:alice:doc-001      ← NEW

                                     Feeds owned by Bob:
                                       ph:v2:user:0xbob             (Bob's own)
                                       ph:v2:ops:bob:doc-001        ← NEW

Data flow:                           Data flow:

  Alice edits                          Alice edits
    ↓                                    ↓
  Plugin buffers (3s)                  SyncManager batches
    ↓                                    ↓
  Upload ops → /bytes                  Upload SyncEnvelope → /bytes
    ↓                                    ↓
  Update doc manifest feed             Write to Alice's op feed
    ↓                                    ↓
  Update drive manifest feed           (Optional: GSOC notify Bob)
    ↓                                    ↓
  Update user manifest feed            Bob polls Alice's op feed
                                         ↓
  Recovery:                            Bob's SyncManager processes
  Read user manifest                     ↓
    ↓                                  Bob's reactor applies ops
  Read drive manifests                   ↓
    ↓                                  Bob sees Alice's changes
  Read doc manifests
    ↓                                  Bob edits
  Download op batches                    ↓
    ↓                                  (same flow in reverse)
  Replay operations                      ↓
                                       Alice polls Bob's op feed
                                         ↓
                                       Alice's reactor applies ops
```

---

## How the Reactor Handles Conflicts

```
Alice and Bob edit the SAME cell at the same time:

Alice: SET_CELL(A1, "100")     Bob: SET_CELL(A1, "200")
  index: 6, skip: 0              index: 4, skip: 0
  hash: aaa                      hash: bbb

Both ops are written to their respective feeds simultaneously.

When Alice receives Bob's op (and vice versa), the reactor's
SyncManager handles it:

1. Detect conflict: same document, overlapping timestamps
2. Reshuffle operations using deterministic ordering:
   - Sort by (timestamp, operationId) for total order
   - Assign new indices with skip values
   - Replay through the document model reducer

   Result on BOTH Alice's and Bob's reactor:
   ┌───────┬──────┬──────────────────┬─────────┐
   │ Index │ Skip │ Action           │ Origin  │
   ├───────┼──────┼──────────────────┼─────────┤
   │   6   │  0   │ SET_CELL(A1,100) │ Alice   │
   │   7   │  1   │ SET_CELL(A1,200) │ Bob     │
   └───────┴──────┴──────────────────┴─────────┘

   Skip=1 on Bob's op means: "this op was reshuffled past 1 other op"

3. Both reactors arrive at the SAME final state
   (deterministic: same ops + same order = same result)

The SwarmChannel does NOT do conflict resolution.
It is just a transport — inbox/outbox/deadLetter.
The reactor's SyncManager + document model reducer handle everything.
```

---

## Feed Topic Naming Convention

```
SINGLE USER FEEDS:
  ph:v2:user:<address>               User's drive index
  ph:v2:drive:<driveId>              Drive's document list + folders
  ph:v2:doc:<docId>                  Document's operation batch list
  ph:v2:profile:<address>            Public profile (unencrypted)
  ph:v2:share:<from>:<to>            Share manifest between users

COLLABORATION FEEDS (new):
  ph:v2:collab:<docId>               Collaboration index (who's in)
  ph:v2:ops:<address>:<docId>        Per-user operation stream

PATTERN:
  Every feed = one owner writing, anyone reading
  Collaboration = N users, each with their own ops feed
  The collab index feed tells everyone where to look
```

---

## Key Design Principles

1. **Each user can only write to their own feed** — Swarm SOCs require the owner's private key. There is no "shared writable feed."

2. **Single-user feeds don't go away during collaboration** — they serve as the user's personal backup. Collaboration feeds are an additional layer on top.

3. **The SwarmChannel is just transport** — it moves `SyncEnvelope` data between feeds and the reactor's mailboxes. All operation ordering, conflict resolution, deduplication, and state computation is handled by the reactor's existing `SyncManager` and document model reducer.

4. **Same ops + same order = same state on every device** — the reactor's deterministic replay guarantees convergence without CRDTs or custom merge logic.

5. **Scaling**: For N collaborators, each user writes to 1 feed and reads N-1 feeds. With GSOC/PSS notifications, reads are proportional to actual edit frequency, not user count.
