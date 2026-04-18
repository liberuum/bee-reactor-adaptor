# Data Duplication Analysis: Swarm vs Switchboard

Comparing what data is stored where, what's duplicated, and the different
architecture options.

> This doc covers the document-sync data path. Chat messages and file
> attachments follow a parallel pattern: PSS for live delivery, ACT-protected
> feeds (`ph:v2:chatlog:<sorted(A,B)>[:chapter]`) for persistent history.
> See [`architecture.md`](./architecture.md) and
> [`chat-collaboration-design.md`](./chat-collaboration-design.md) for the chat data path.

---

## Data Layers

```
LAYER 1: PGlite (browser, ephemeral)
══════════════════════════════════════
- Operations table: every operation for every document
- Documents table: document headers, current state snapshots
- Relationships: drive → document mappings
- Keyframes: periodic state snapshots

SURVIVES: page refresh (IndexedDB-backed PGlite)
LOST ON:  "Clear site data", new device, new browser


LAYER 2: Swarm /bytes (immutable, permanent until stamp expires)
════════════════════════════════════════════════════════════════
- Operation batches: encrypted JSON arrays of operations
- Manifest payloads: encrypted JSON (doc/drive/user manifests)

These are CONTENT-ADDRESSED. Once uploaded, they never change.
The same data uploaded twice = same reference (deduped by the network).

SURVIVES: everything (decentralized, replicated across neighborhood)
LOST ON:  stamp expiration (chunks evicted from reserves)


LAYER 3: Swarm feeds (mutable pointers, one per topic)
══════════════════════════════════════════════════════════
- Feed updates: 64-char hex references pointing to /bytes data
- Each feed index is WRITE-ONCE (append-only sequence)

These are MUTABLE in the sense that you can write index 0, then 1, then 2...
But each individual index is immutable once written.

SURVIVES: everything (same as /bytes)
LOST ON:  stamp expiration


LAYER 4: IndexedDB caches (browser, ephemeral helpers)
══════════════════════════════════════════════════════════
- Manifest index: docId → latest /bytes reference (for bee dev mode)
- Pending ops: buffered ops not yet flushed to Swarm
- Swarm key cache: wallet-derived signer key

SURVIVES: page refresh
LOST ON:  "Clear site data"
```

---

## What's Duplicated vs Unique

```
                        PGlite    Swarm /bytes   Swarm feeds   IndexedDB
                        ══════    ════════════   ═══════════   ═════════
Operations (raw data)     ✓           ✓                           △
                        PRIMARY    BACKUP                    (pending only)

Document state            ✓
(computed from ops)     DERIVED
                       (not on Swarm)

Doc manifest                          ✓              ✓
(list of batch refs)               PAYLOAD         POINTER

Drive manifest                        ✓              ✓
(doc list + folders)               PAYLOAD         POINTER

User manifest                         ✓              ✓
(drive index)                      PAYLOAD         POINTER

Signer key                                                       ✓
                                                              CACHE ONLY
                                                          (re-derivable from wallet)

Pending ops buffer                                               ✓
                                                            TEMPORARY
                                                        (cleared after flush)
```

---

## The Reactor's Native Sync (Connect ↔ Switchboard)

```
CONNECT (browser)                    SWITCHBOARD (server)
════════════════                     ════════════════════

PGlite (local)                       PostgreSQL (remote)
  - operations                         - operations (SAME data)
  - documents                          - documents
  - relationships                      - relationships

SyncManager                          SyncManager
  outbox → GqlRequestChannel ──────→ inbox → reactor.load()
  inbox  ← GqlRequestChannel ←────── outbox

Every operation exists in BOTH databases.
The SyncManager ensures eventual consistency.
```

In the native flow, **every operation is stored twice**: once in PGlite (browser), once in PostgreSQL (Switchboard). The GraphQL channel moves `SyncEnvelope` payloads between them. The Switchboard is the authoritative remote — it's a server someone runs.

---

## Our Swarm Plugin (Current, Single-User)

```
CONNECT (browser)                    SWARM NETWORK
════════════════                     ═══════════════

PGlite (local)                       /bytes (encrypted ops)
  - operations                         - operation batches (SAME ops)
  - documents                        Feeds (pointers)
  - relationships                      - doc/drive/user manifests
```

**Same duplication pattern** — operations exist in PGlite AND on Swarm. Swarm replaces the Switchboard's PostgreSQL as the durable remote copy.

---

## Running Both Simultaneously

If Connect has the native SyncManager syncing to a Switchboard AND our plugin syncing to Swarm:

```
CONNECT (browser)          SWITCHBOARD (server)       SWARM NETWORK
════════════════           ════════════════════        ═══════════════

PGlite                     PostgreSQL                  /bytes + feeds
  - operations ──────────→ - operations
              ←──────────
                                                       - operation batches
  - operations ──────────────────────────────────────→ - manifests


Operations stored 3x:
  1. PGlite (browser)
  2. PostgreSQL (Switchboard)
  3. Swarm /bytes (encrypted)
```

**Three copies of every operation.** That's the duplication cost of running both sync paths simultaneously.

---

## What Each Copy Is For

| Copy | Where | Purpose | Can recover from it alone? |
|------|-------|---------|:---:|
| PGlite | Browser | Fast local reads, UI rendering | No (ephemeral) |
| PostgreSQL | Switchboard | Multi-device sync, team collaboration, server-side processing | Yes (authoritative) |
| Swarm /bytes | Decentralized network | Censorship-resistant backup, serverless recovery, wallet-based access | Yes (self-sovereign) |

---

## The 4 Architecture Options

### Architecture A: Connect + Switchboard (current Powerhouse default)

```
PGlite ←→ Switchboard (PostgreSQL) via GraphQL SyncManager

Duplication: 2x (PGlite + PostgreSQL)
Recovery:    from Switchboard
Requires:    running a server
```

### Architecture B: Connect + Swarm (our plugin, no Switchboard)

```
PGlite → Swarm via plugin

Duplication: 2x (PGlite + Swarm)
Recovery:    from Swarm (wallet signature)
Requires:    running a Bee node (local or remote)
```

### Architecture C: Connect + Switchboard + Swarm (both)

```
PGlite ←→ Switchboard via GraphQL SyncManager
PGlite → Swarm via plugin

Duplication: 3x (PGlite + PostgreSQL + Swarm)
Recovery:    from either Switchboard OR Swarm
Requires:    server + Bee node
```

### Architecture D: Connect on Swarm (fully decentralized — end goal)

```
Connect SPA deployed to Swarm via ENS
PGlite ←→ Swarm via plugin (no Switchboard at all)
Collaboration: SwarmChannel (peer-to-peer via feeds)

Duplication: 2x (PGlite + Swarm) — same as Architecture B
Recovery:    from Swarm (wallet signature)
Requires:    wallet + local Bee node
Servers:     ZERO
```

In this architecture, Swarm IS the Switchboard. The `SwarmChannel` implements `IChannel` (inbox/outbox/deadLetter) and plugs into the reactor's existing SyncManager — replacing the `GqlRequestChannel` that talks to a server. The SyncManager doesn't know or care that the transport changed from GraphQL to Swarm feeds. It just moves `SyncEnvelope` data through the channel.

**The duplication is identical to the current Switchboard model** — 2x (local + remote). We're just swapping WHERE the remote copy lives: server PostgreSQL → decentralized Swarm network.

---

## What's Immutable vs Ephemeral

```
                    PGlite    PostgreSQL    Swarm /bytes    Swarm feeds
                    ══════    ══════════    ════════════    ═══════════
Lifespan          Ephemeral   Persistent    Until stamp     Until stamp
                  (browser)   (server)      expires         expires

Mutability        Mutable     Mutable       IMMUTABLE       Append-only
                  (can delete (can delete   (content-       (each index
                   clear DB)   rows)         addressed)      write-once)

Who controls it   User's      Server        Nobody          Feed owner
                  browser     operator      (decentralized)  (private key)

Auth required     None        API key /     Postage stamp   Private key
                  (local)     auth token                     signature
```

---

## Size Analysis for a Typical User

```
Alice has 1 drive, 5 documents, ~100 operations total:

PGlite:
  Operations:     ~100 rows × ~500 bytes each ≈ 50 KB
  Documents:      ~5 rows × ~2 KB each ≈ 10 KB
  Relationships:  ~5 rows × ~100 bytes ≈ 0.5 KB
  Total PGlite:   ~60 KB

Swarm /bytes (encrypted):
  Operation batches: ~100 ops in ~5 batches × ~10 KB ≈ 50 KB
  Doc manifests:     5 × ~1 KB ≈ 5 KB
  Drive manifest:    1 × ~2 KB ≈ 2 KB
  User manifest:     1 × ~1 KB ≈ 1 KB
  Total /bytes:      ~58 KB

Swarm feeds:
  User feed:         1 index × 64 bytes = 64 bytes
  Drive feed:        1 index × 64 bytes = 64 bytes
  Doc feeds:         5 × ~2 indices × 64 bytes = 640 bytes
  Total feeds:       ~768 bytes (< 1 KB)

IndexedDB:
  Manifest index:    ~5 entries × 100 bytes = 500 bytes
  Pending ops:       0 (all flushed)
  Signer key:        ~200 bytes
  Total IndexedDB:   ~700 bytes

GRAND TOTAL:
  PGlite:      ~60 KB  (ephemeral, recoverable)
  Swarm:       ~59 KB  (permanent, encrypted)
  IndexedDB:   ~1 KB   (ephemeral, cache)
  ─────────────────────
  Total:       ~120 KB
  Duplication: ~50 KB (operations stored in both PGlite and Swarm)
  Overhead:    ~10 KB (manifests, feeds, caches — not duplication, metadata)
```

---

## Collaboration Adds Minimal Overhead

```
Collaboration adds per-user op feeds. The duplication picture:

EXISTING (same as single user):
  PGlite:           all operations (local + remote)
  Swarm /bytes:     operation batches (per user)
  Single-user feeds: doc/drive/user manifests (personal backup)

NEW:
  Collab index feed:  1 per shared document (~1 KB)
  Per-user op feeds:  1 per user per document
    Content: SyncEnvelopes wrapping the SAME operations
    that are already in the single-user /bytes batches

Collaboration adds:
  - Feed pointers (~64 bytes per update per user)
  - SyncEnvelope wrappers around operations
    (same ops but with OperationContext metadata)

The actual operation data is the same — it's just also wrapped
in SyncEnvelope format for the reactor's SyncManager. This adds
~20% overhead per op (the context metadata) but the core action
data is not duplicated again.
```

---

## Bottom Line

The only real duplication is **operations existing in both PGlite and Swarm** — and that's the same pattern as the current Switchboard model (PGlite + PostgreSQL = 2 copies). We're just replacing the server with a decentralized network.

The end-goal architecture (D) has **the same 2x duplication as the current Powerhouse default** — we just don't need a server anymore.
