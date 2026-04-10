# Multi-User Document Collaboration via Swarm

How multiple users collaborate on a single document using Swarm as the transport, with the reactor's existing sync protocol handling operation ordering and conflict resolution.

## The Core Constraint

**Each user can only write to their own Swarm feed** (SOC requires the owner's private key). There is no "shared writable feed." So we use a **multi-author pattern**: each user writes to their own operation feed, and everyone polls everyone else's feeds.

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                        SWARM NETWORK                                 │
│                                                                      │
│   ┌─────────────────────────────┐                                    │
│   │   Collaboration Index Feed  │  Topic: ph:v2:collab:<docId>       │
│   │   Owner: Alice (creator)    │  Created when Alice shares doc     │
│   │                             │                                    │
│   │   {                         │                                    │
│   │     docId: "doc-123",       │                                    │
│   │     documentType: "...",    │                                    │
│   │     collaborators: [        │                                    │
│   │       {                     │                                    │
│   │         address: "0xAlice", │                                    │
│   │         opFeedTopic: "ph:v2:ops:alice:doc-123"                   │
│   │       },                    │                                    │
│   │       {                     │                                    │
│   │         address: "0xBob",   │                                    │
│   │         opFeedTopic: "ph:v2:ops:bob:doc-123"                     │
│   │       }                     │                                    │
│   │     ]                       │                                    │
│   │   }                         │                                    │
│   └─────────────────────────────┘                                    │
│                                                                      │
│   ┌──────────────────────┐       ┌──────────────────────┐            │
│   │  Alice's Op Feed     │       │  Bob's Op Feed       │            │
│   │  Owner: Alice        │       │  Owner: Bob          │            │
│   │                      │       │                      │            │
│   │  Index 0: [ops 0-3]  │       │  Index 0: [ops 0-1]  │            │
│   │  Index 1: [ops 4-7]  │       │  Index 1: [ops 2-5]  │            │
│   │  Index 2: [ops 8-12] │       │  Index 2: [ops 6-8]  │            │
│   │  ...                 │       │  ...                 │            │
│   └──────────┬───────────┘       └──────────┬───────────┘            │
│              │                               │                       │
└──────────────┼───────────────────────────────┼───────────────────────┘
               │                               │
    ┌──────────▼──────────┐         ┌──────────▼──────────┐
    │   Alice's Connect   │         │   Bob's Connect     │
    │                     │         │                     │
    │  Reactor            │         │  Reactor            │
    │  ├── PGlite (local) │         │  ├── PGlite (local) │
    │  ├── SyncManager    │         │  ├── SyncManager    │
    │  │   └── SwarmChannel        │  │   └── SwarmChannel│
    │  │       ├── outbox ─────────┤  │       ├── outbox ─────┐
    │  │       ├── inbox ◄─────────┤  │       ├── inbox ◄─────┘
    │  │       └── deadLetter      │  │       └── deadLetter  │
    │  └── DocumentView   │         │  └── DocumentView   │
    │                     │         │                     │
    │  Bee Node (local)   │         │  Bee Node (local)   │
    └─────────────────────┘         └─────────────────────┘
```

## Step-by-Step Flow

### Phase 1: Alice Creates and Shares a Document

```
Alice creates "Q1 Budget" in her Connect app
       │
       ▼
1. Reactor stores operations in PGlite
2. Plugin syncs ops to Alice's document feed (ph:v2:doc:doc-123)
       │
       ▼
Alice shares with Bob via the Share UI
       │
       ▼
3. Plugin creates a Collaboration Index Feed:
   Topic: ph:v2:collab:doc-123
   Owner: Alice
   Content: { collaborators: [alice, bob], documentType, ... }

4. Plugin creates Alice's Op Feed:
   Topic: ph:v2:ops:alice:doc-123
   Owner: Alice
   Content: SyncEnvelopes with Alice's operations

5. Plugin sends Bob a PSS notification:
   "Alice shared doc-123 with you, collab feed: ph:v2:collab:doc-123"
```

### Phase 2: Bob Joins the Collaboration

```
Bob receives PSS notification (or manually enters Alice's Swarm ID)
       │
       ▼
6. Bob's plugin reads the Collaboration Index Feed
   → discovers Alice's op feed topic + Bob's expected op feed topic
       │
       ▼
7. Bob's SyncManager creates a SwarmChannel for this document:
   - outbox: writes to Bob's op feed (ph:v2:ops:bob:doc-123)
   - inbox: polls Alice's op feed (ph:v2:ops:alice:doc-123)
       │
       ▼
8. Bob's SwarmChannel polls Alice's op feed
   → downloads SyncEnvelopes containing Alice's operations
   → adds to inbox
       │
       ▼
9. Bob's SyncManager processes inbox:
   → reactor.load(docId, branch, operations)
   → operations replayed in PGlite
   → Bob now sees Alice's document
```

### Phase 3: Both Users Edit Simultaneously

```
Timeline:
─────────────────────────────────────────────────────────────────────

Alice (local)          Swarm Feeds              Bob (local)
═══════════════        ═══════════════           ═══════════════

Edit "Add row A1"
  │
  ▼
Op stored in PGlite
(index: 5, hash: abc)
  │
  ▼
SyncManager picks up ──►  Alice's Op Feed       Bob polls Alice's feed
JOB_WRITE_READY           [SyncEnvelope:        ◄── every 5-10 seconds
  │                        op index 5,
  ▼                        hash: abc,           Gets new SyncEnvelope
SwarmChannel.outbox        action: ADD_ROW]       │
  │                                               ▼
  ▼                                             SwarmChannel.inbox
Write to Alice's feed                             │
(3s debounce)                                     ▼
                                                SyncManager.load()
                                                  │
                                                  ▼
                         Bob's Op Feed          Reactor applies ops
                                                PGlite updated
                                                Bob sees "Add row A1"
                                                  │
                                                  │ Bob edits
                                                  │ "Add row B1"
                                                  │
                                                  ▼
                                                Op stored in PGlite
                                                (index: 3, hash: def)
                                                  │
                                                  ▼
Alice polls Bob's feed   [SyncEnvelope:         SyncManager picks up
◄── every 5-10 seconds    op index 3,           JOB_WRITE_READY
  │                        hash: def,             │
  ▼                        action: ADD_ROW]       ▼
SwarmChannel.inbox                              SwarmChannel.outbox
  │                                               │
  ▼                                               ▼
SyncManager.load()                              Write to Bob's feed
  │                                             (3s debounce)
  ▼
Reactor applies ops
PGlite updated
Alice sees "Add row B1"
```

### Phase 4: Conflict Resolution (Handled by Reactor)

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

## SwarmChannel Implementation

The `SwarmChannel` implements the reactor's `IChannel` interface:

```typescript
class SwarmChannel implements IChannel {
  inbox: IMailbox;      // Ops received from other collaborators
  outbox: IMailbox;     // Our ops to send to collaborators
  deadLetter: IMailbox; // Failed ops

  // Our op feed (we write to this)
  private myOpFeed: { topic: Topic; writer: FeedWriter };

  // Other collaborators' op feeds (we poll these)
  private peerFeeds: Array<{ address: string; topic: Topic; cursor: number }>;

  // Polling interval
  private pollTimer: ReturnType<typeof setInterval>;

  async init(): Promise<void> {
    // 1. Read collaboration index feed → get list of collaborators
    // 2. Create our op feed writer
    // 3. Create feed readers for each peer
    // 4. Start polling
  }

  // Called by SyncManager when local ops are ready to send
  // (outbox.onAdded callback)
  private async flushOutbox(): Promise<void> {
    // 1. Drain outbox items
    // 2. Serialize as SyncEnvelopes
    // 3. Encrypt + upload to /bytes
    // 4. Write reference to our op feed
    // 5. (Optional) Send GSOC/PSS notification to peers
  }

  // Called on poll timer
  private async pollPeers(): Promise<void> {
    for (const peer of this.peerFeeds) {
      // 1. Read peer's op feed from their last known cursor
      // 2. Download + decrypt SyncEnvelopes
      // 3. Add to inbox
      // 4. Update cursor
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.pollTimer);
  }
}
```

## Feed Layout

```
Per-document collaboration feeds:

ph:v2:collab:<docId>              ← Collaboration index (created by document owner)
  Owner: document creator
  Content: { collaborators, documentType, createdAt }

ph:v2:ops:<signerAddress>:<docId> ← Per-user operation feed
  Owner: the user
  Content: SyncEnvelopes (batched, encrypted)

Each user writes ONLY to their own ph:v2:ops feed.
Each user reads ALL other collaborators' ph:v2:ops feeds.
```

## Notification Options (Avoiding Constant Polling)

### Option A: Poll Only (simplest, 5-10s latency)

```
Every 5-10 seconds:
  for each peer:
    read peer's op feed
    if new index > our cursor:
      download + add to inbox
```

### Option B: GSOC-Triggered Poll (sub-second latency)

```
On write to our op feed:
  for each peer:
    gsocSend(peer.overlay, notification)

Peer receives GSOC notification via WebSocket:
  → immediately poll that specific peer's feed
  → add new ops to inbox
```

### Option C: PSS Notification + Poll (works even with NAT)

```
On write to our op feed:
  for each peer:
    pssSend(peer.topic, peer.overlay, "new ops on my feed")

Peer receives PSS via WebSocket:
  → poll sender's feed
  → add new ops to inbox
```

### Option D: PSS Direct Delivery (lowest latency, no feed needed)

```
On write:
  for each peer:
    pssSend(peer.topic, peer.overlay, actualSyncEnvelopeData)

Peer receives ops directly via WebSocket:
  → add to inbox immediately (no feed read needed)
  → ALSO write to own feed for persistence/recovery
```

## Operation Ordering Guarantees

```
CRITICAL INVARIANT: The reactor handles ALL ordering.

The SwarmChannel's job is ONLY:
  1. Transport ops from outbox → peer's inbox
  2. Transport ops from peer's outbox → our inbox
  3. Track cursors (what we've already seen)

The SyncManager handles:
  - Deduplication (same op ID seen from multiple paths)
  - Ordering (deterministic sort by timestamp + op ID)
  - Reshuffling (adjust indices and skip values)
  - Conflict resolution (same cell edited by two users)

The document model reducer handles:
  - State computation (replay all ops in order → final state)
  - Integrity (hash chain verification)

This separation is why we DON'T need CRDTs, custom merge logic,
or any conflict resolution code in the Swarm layer.
```

## Recovery After Offline Period

```
Alice was offline for 2 days. Bob made 50 edits.

Alice comes back online:
  1. SwarmChannel.pollPeers() runs
  2. Reads Bob's op feed from Alice's last cursor position
  3. Downloads all 50 SyncEnvelopes (may be across multiple feed indices)
  4. Adds to inbox
  5. SyncManager processes them as load jobs
  6. Reactor replays all 50 operations
  7. Alice's PGlite is caught up
  8. Alice can now edit — her new ops go to her op feed
  9. Bob will pick them up on his next poll
```

## Scaling: 3+ Collaborators

```
Alice, Bob, and Carol collaborate on doc-123:

Collaboration Index:
  collaborators: [
    { address: alice, topic: ph:v2:ops:alice:doc-123 },
    { address: bob,   topic: ph:v2:ops:bob:doc-123 },
    { address: carol,  topic: ph:v2:ops:carol:doc-123 }
  ]

Each user's SwarmChannel:
  - Writes to: their own op feed (1 feed)
  - Polls: all OTHER collaborators' feeds (N-1 feeds)

Alice polls Bob + Carol
Bob polls Alice + Carol
Carol polls Alice + Bob

Total feed reads per poll cycle: N * (N-1)
For 3 users: 6 feed reads per cycle
For 10 users: 90 feed reads per cycle

With GSOC/PSS notifications: only poll when notified
→ reads proportional to actual edit frequency, not user count
```

## What We Build vs What the Reactor Already Does

| Concern | Who handles it | Already built? |
|---------|---------------|:-:|
| Operation storage (PGlite) | Reactor | Yes |
| Operation ordering | SyncManager | Yes |
| Conflict resolution | SyncManager + reducer | Yes |
| Deduplication | SyncManager | Yes |
| Document state computation | Document model reducer | Yes |
| **Transport (inbox/outbox)** | **SwarmChannel** | **NO — we build this** |
| **Feed read/write** | **SwarmClient** | **Yes** |
| **Encryption** | **SwarmClient** | **Yes** |
| **Notification** | **PSS/GSOC** | **Available, not wired** |
| **Collaboration index** | **New feed type** | **NO — we build this** |
