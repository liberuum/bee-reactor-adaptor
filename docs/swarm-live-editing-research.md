# Research: Multi-User Live Document Editing on Swarm

## The Key Insight: SwarmChannel + DocSync = Collaboration for Free

Powerhouse's **DocSync** protocol already solves the hard problems of collaborative editing:
- Operation ordering (SyncManager sorts by documentId + scope + ordinal)
- Deduplication (cursor tracking prevents replaying ops)
- Batching (groups ops by document)
- Error handling (dead letter queue)
- Eventual consistency (built-in)
- Authentication (operations are cryptographically signed via Renown)

DocSync is **storage-agnostic** and uses **Channels** as the transport abstraction.
Currently, the browser uses `GqlRequestChannel` to sync with Switchboard via GraphQL.

**We just need to build a `SwarmChannel`** — a Channel implementation that uses Swarm feeds
instead of GraphQL. The SyncManager handles everything else.

```
Current (GraphQL):
  Local edit → PGlite → SyncManager → GqlRequestChannel.outbox → pushSyncEnvelopes → Switchboard
  Switchboard → pollSyncEnvelopes → GqlRequestChannel.inbox → SyncManager → PGlite → apply

Swarm (our SwarmChannel):
  Local edit → PGlite → SyncManager → SwarmChannel.outbox → write SyncEnvelopes to own Swarm feed
  Other user's Swarm feed → poll/GSOC → SwarmChannel.inbox → SyncManager → PGlite → apply
```

The reactor is the brain. Swarm is just the pipe. We don't build merge logic — we build a transport adapter.

---

## Swarm Primitives Available

### 1. Feeds (SOC) — Mutable Pointers, Single Writer
- **Single-writer only**: Only the private key owner can update a feed
- Sequential index (0, 1, 2...), each update points to immutable /bytes data
- Deterministic address: `hash(topic + owner_address)` — anyone can read, no key needed
- Pattern: "Regenerate and publish" — upload data to /bytes, write reference to feed

### 2. GSOC (Graffiti Several Owner Chunks) — Many-to-One Real-Time Messaging
- Multiple writer nodes can send messages to ONE service (listener) node
- GSOC address is mined to fall into the listener's network neighborhood
- WebSocket subscription: listener gets events in real-time as messages arrive
- **Requirement**: Listener MUST be a full Bee node
- Should use **mutable** postage stamps (overwrite same bucket slot)
- bee-js API:
  ```js
  // Listener mines a key matching their overlay
  const signer = bee.gsocMine(myOverlay, identifier, proximity)
  // Listener subscribes via WebSocket
  const sub = bee.gsocSubscribe(signer.publicKey().address(), identifier, {
    onMessage: (msg) => console.log(msg.toJSON()),
    onError: (err) => console.error(err),
  })
  // Writer mines the SAME key from the listener's overlay
  const signer = bee.gsocMine(listenerOverlay, identifier, proximity)
  // Writer sends
  await bee.gsocSend(batchId, signer, identifier, "Hello!")
  ```
- Think of it as: **a decentralized inbox/notification bell**

### 3. PSS (Postal Service over Swarm) — Point-to-Point Encrypted Messaging
- Direct encrypted messages between two nodes
- Messages are wrapped as "Trojan Chunks" — look like normal Swarm traffic
- Encrypted for the specific recipient (needs their public key)
- **Mailboxing**: messages persist even if recipient is offline (synced as chunks)
- **Requirement**: Recipient MUST be a full node
- bee-js API:
  ```js
  // Send: needs recipient's overlay prefix + public key
  await bee.pssSend(batchId, topic, targetPrefix, data, recipientPubKey)
  // Receive: subscribe via WebSocket
  const sub = bee.pssSubscribe(topic, {
    onMessage: (msg) => console.log(msg),
  })
  ```
- Think of it as: **encrypted DMs over Swarm**

### 4. Multi-Author Blog Pattern — Feeds Referencing Feeds
From the Swarm docs example:
```
Index Feed (admin)
  └─ authors.json → [{name, topic, owner, feedManifest}, ...]
Alice's Feed (alice key) → Alice's content
Bob's Feed (bob key) → Bob's content
```
- Each author writes independently to their own feed
- An index feed lists all authors (their topics + owner addresses)
- Any reader can discover all authors from the index
- Authors need NO coordination — fully independent

**Key insight**: You don't need a shared writable feed. Each user writes to their own feed, and an index references all of them.

---

## How Live Collaborative Editing Works: SwarmChannel + DocSync

### The Architecture

We don't build merge logic — we build a **transport adapter** for the existing DocSync protocol.

DocSync uses **Channels** with **mailboxes** (inbox, outbox, deadLetter). The `GqlRequestChannel`
pushes/polls operations via GraphQL mutations/queries. A `SwarmChannel` does the same
over Swarm feeds.

### SwarmChannel Design

```typescript
class SwarmChannel implements Channel {
  inbox: Mailbox;    // ops received from collaborators' Swarm feeds
  outbox: Mailbox;   // ops to write to own Swarm feed
  deadLetter: Mailbox;

  // Outbox → Swarm: write batched SyncEnvelopes to own feed
  async flush(): Promise<void> {
    const ops = this.outbox.drain();
    if (ops.length === 0) return;
    const { reference } = await swarmClient.uploadData(JSON.stringify(ops));
    await swarmClient.writeFeedPayload(myOpTopic, reference);
  }

  // Swarm → Inbox: poll collaborators' feeds for new SyncEnvelopes
  async poll(): Promise<void> {
    for (const collab of collaborators) {
      const reader = bee.makeFeedReader(collab.topic, collab.ownerAddress);
      const result = await reader.downloadPayload();
      if (result.feedIndex > collab.lastKnownIndex) {
        const ops = JSON.parse(new TextDecoder().decode(result.payload));
        this.inbox.add(...ops);
        collab.lastKnownIndex = result.feedIndex;
      }
    }
  }
}
```

### Feed Layout (Multi-Author Blog Pattern Applied to DocSync)

Each user writes SyncEnvelopes to their own feed. A collaboration index references all feeds.

```
Collaboration Index Feed (document creator, e.g. Alice)
  Topic: ph:v2:collab:<docId>
  Owner: Alice's signer address
  Payload → collab.json:
    {
      "documentId": "abc-123",
      "collaborators": [
        { address: "0xAlice", topic: "ph:v2:ops:0xAlice:abc-123", overlayAddress: "..." },
        { address: "0xBob",   topic: "ph:v2:ops:0xBob:abc-123",   overlayAddress: "..." }
      ]
    }

Alice's Op Feed: ph:v2:ops:<alice>:<docId> → SyncEnvelopes (same format as DocSync)
Bob's Op Feed:   ph:v2:ops:<bob>:<docId>   → SyncEnvelopes (same format as DocSync)
```

### What the SyncManager Already Handles (We Don't Build)

| Problem | DocSync Solution | Our Job |
|---------|-----------------|---------|
| Operation ordering | SyncManager sorts by ordinal | Provide SyncEnvelopes via inbox |
| Deduplication | Cursor tracking + `excludeSourceRemote` | Track feed index per collaborator |
| Conflict resolution | Ops are append-only, reducers are deterministic | Nothing — same ops in same order = same state |
| Error handling | Dead letter queue | Forward errors to deadLetter mailbox |
| Recovery | Replay all ops from all sources | Read all collaborator feeds on startup |
| Authentication | Renown SDK signatures on operations | Operations are already signed |
| Batching | `batchOperationsByDocument()` in SyncManager | Standard — ops batched before outbox flush |
| Dependency chains | `prevJobId` links in SyncOperation | Handled by SyncManager |

### Three Transport Strategies for the SwarmChannel

#### Strategy A: Polling (Start Here)
```
SwarmChannel.poll() runs every 5-10 seconds:
  for each collaborator:
    read their op feed → new SyncEnvelopes → add to inbox
    SyncManager handles the rest
```
- Works with any node type (light or full)
- 5-10s latency
- Simple, reliable

#### Strategy B: GSOC Notifications + Pull (Near Real-Time)
```
On flush (outbox → own feed):
  also send GSOC notification to each collaborator's overlay:
    { type: "ops-available", from: "0xAlice", docId: "abc-123", feedIndex: 48 }

On GSOC received:
  immediately poll that collaborator's feed → inbox
  SyncManager handles the rest
```
- Sub-second latency
- Requires full Bee nodes
- GSOC = "you have new mail" bell, feed = the actual mail

#### Strategy C: PSS Direct Ops (Real-Time, Encrypted)
```
On flush:
  send SyncEnvelopes directly via PSS to each collaborator (encrypted for their pubkey)
  also write to own feed (persistence/recovery backup)

On PSS received:
  add SyncEnvelopes directly to inbox (skip feed read)
  SyncManager handles the rest
```
- Fastest possible (direct messaging)
- End-to-end encrypted by PSS
- Mailboxing: works even if recipient is temporarily offline
- Requires full Bee nodes

---

## Implementation Roadmap

```
DONE: Single-user sync to Swarm (swarm-plugin.ts)
   ↓
DONE: Encrypted sharing (drive bundles, Phase C)
   ↓
Step 2: SwarmChannel + polling (5-10s)              ← Next: live editing
   ↓
Step 3: SwarmChannel + GSOC (sub-second)            ← Real-time notifications
   ↓
Step 4: SwarmChannel + PSS (encrypted real-time)    ← Full production
```

### Step 2: SwarmChannel — What We Actually Build

1. **Implement SwarmChannel class** (new file in bee-reactor-adaptor)
   - Implements the Channel interface from `@powerhousedao/reactor`
   - inbox/outbox/deadLetter mailboxes
   - `flush()`: drain outbox → upload SyncEnvelopes to /bytes → write ref to own op feed
   - `poll()`: read collaborators' feeds → download SyncEnvelopes → add to inbox

2. **Collaboration Index Feed**
   - When Alice shares a doc (Step 1), she creates a collab index feed
   - Bob reads the index to discover Alice's op feed topic
   - Bob creates his own op feed, Alice adds him to the index
   - Feed topic: `ph:v2:collab:<docId>`, owner: document creator

3. **Register SwarmChannel with SyncManager**
   - In swarm-plugin.ts, after ACT sharing/import, register a SwarmChannel as a remote
   - SyncManager treats it like any other channel — pushes ops to outbox, reads from inbox
   - Existing GqlRequestChannel (Switchboard) can coexist — sync to both

4. **Feed format = SyncEnvelopes**
   - Use the exact same SyncEnvelope format DocSync uses
   - Contains: documentId, scope, branch, operations[]
   - The SyncManager already knows how to process these
   - Operations already carry Renown signatures — no extra auth needed

5. **Encryption for shared feeds**
   - Use ACT (Bee node key) for the collaboration feeds
   - All collaborators are granted access via ACT
   - Or: use ECDH shared secret (wallet-derived) for app-layer encryption

### What We DON'T Need to Build
- No custom merge logic (SyncManager handles ordering + dedup)
- No CRDTs (operations are deterministically ordered by the reactor)
- No changes to reactor core (just a new Channel implementation)
- No changes to document models (operations are already the unit of sync)
- No conflict resolution UI (DocSync's append-only model avoids conflicts)

---

## Key Takeaways

1. **DocSync is the collaboration engine** — it already handles ordering, dedup, batching, errors, and consistency
2. **We only build a transport** — SwarmChannel is a thin adapter between Swarm feeds and DocSync's Channel interface
3. **Swarm feeds are single-writer** — the multi-author blog pattern (feeds-of-feeds) is how you do multi-user
4. **GSOC = instant notifications** — many writers → one listener, real-time via WebSocket
5. **PSS = encrypted DMs** — point-to-point messaging, works even when offline (mailboxing)
6. **Polling is the right starting point** — 5-10s latency, works with any node type, simple to implement
7. **The reactor does the heavy lifting** — we just need to get SyncEnvelopes from Swarm into the inbox
