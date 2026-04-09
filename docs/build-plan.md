# Swarm Integration — Build Plan

What's done and what's next for the Powerhouse Connect + Swarm decentralized storage integration.

---

## What's Built

### Core Adapter (`@liberuum-org/bee-reactor-adapter`)

- **SwarmClient** — Bee SDK wrapper with feed mode + bytes mode
- **Wallet Signer** — deterministic secp256k1 key from `personal_sign` + `keccak256`
- **AES-256-GCM encryption** — all uploads encrypted with wallet-derived key, auto-decrypt on download
- **Feed optimization** — debounced doc manifest writes (3s), op batch accumulation, per-topic write lock, manifest-as-reference (upload to /bytes, write ref to feed), manifest compaction on startup
- **Stamp management** — status, top-up, expand, create, cost estimation, USD pricing via CoinGecko
- **ACT access control API** — `uploadData({act:true})`, `grantAccess()`, `revokeAccess()`

### Hierarchical Manifests

- **User manifest** — lists drives only (small, rarely changes)
- **Drive manifests** — per-drive Swarm feed listing all documents + folder structure
- **Document manifests** — per-document feed listing operation batches
- **Drive manifest cache** — in-memory source of truth (avoids stale Swarm reads during rapid writes)
- **Concurrent flush throttle** — max 5 parallel doc manifest flushes

### Folder Structure

- **Folder tracking** — reads drive's `state.global.nodes` tree during each flush, stores folders + parentFolder in drive manifest
- **Folder restore on recovery** — ADD_FOLDER + MOVE_NODE actions with proper `createAction()` shape (`id`, `timestampUtcMs`, `scope: "global"`)
- **Folder restore on import** — share bundles include `folders` + `docFolders` maps; import restores using original→local ID mapping
- **Settings UI tree** — both Documents and Share sections render folder hierarchy

### Document Sharing

- **Public profile feed** — publishes Bee node pubkey + signer address on `ph:v2:profile:<address>` (unencrypted)
- **Share manifest feed** — `ph:v2:share:<sender>:<recipient>` stores shared drive bundles
- **Encrypted shared data** — SHA-256 derived shared key, AES-256-GCM encrypted
- **Drive bundle format** — `{ documents, folders, docFolders }` — one upload per drive with folder metadata
- **Import with drive dedup** — creates single drive, reuses on repeated imports, restores folder structure

### Connect Plugin (`swarm-doc-model/processors/swarm-plugin.ts`)

- Subscribes to ALL reactor document changes, uploads new ops to Swarm
- Hierarchical manifest writes (user → drive → document)
- Recovery from Swarm (drive manifests → docs → folder structure)
- Sharing and import with folder structure preservation
- Debounced writes (3s doc, 3s user, 2s drive manifests)
- Op batch accumulation — all ops per flush as ONE /bytes batch
- Clean manifest after recovery (prevents stale accumulation)
- `beforeunload` handler flushes pending manifests
- Exposes on `ph.swarm`: `clearStorage()`, `reconnect()`, `refreshBalances()`, `setBeeUrl()`, `shareDocuments()`, `importSharedDocuments()`, `lookupUser()`

### Connect Settings UI (`packages/connect/.../swarm-storage.tsx`)

- Configurable Bee node URL with Save & Connect
- Storage gauge (capacity, TTL, utilization)
- Document tree with sync badges, drive grouping, folder hierarchy
- Your Swarm ID — copyable signer address
- Share section — checkbox tree with folder hierarchy, batch share with encryption
- Import section — enter sender's Swarm ID, import shared docs with folder structure
- Stamp management (extend, expand, create new with dropdown presets)
- Node wallet balances (xBZZ, xDAI), USD pricing, alert banners

---

## What's Next

### 1. SwarmChannel + DocSync (Live Collaborative Editing)

The biggest feature unlock. Implement a `SwarmChannel` that plugs into the reactor's existing DocSync protocol. DocSync already handles operation ordering, deduplication, conflict resolution, and batching — we just build the transport.

**Architecture:**
```
Current (single-user):
  Edit → PGlite → swarm-plugin → /bytes + feed → Swarm

With SwarmChannel (multi-user):
  Edit → PGlite → SyncManager → SwarmChannel.outbox → own feed → Swarm
  Collaborator's feed → poll → SwarmChannel.inbox → SyncManager → PGlite → apply
```

**Feed layout (multi-author blog pattern):**
```
Collaboration Index Feed: ph:v2:collab:<docId> (document creator)
  → { collaborators: [{ address, topic, overlayAddress }, ...] }

Alice's Op Feed: ph:v2:ops:<alice>:<docId> → SyncEnvelopes
Bob's Op Feed:   ph:v2:ops:<bob>:<docId>   → SyncEnvelopes
```

**Implementation:**
1. `SwarmChannel` class implementing Channel interface (inbox/outbox/deadLetter)
2. `flush()`: drain outbox → upload SyncEnvelopes to /bytes → write ref to own op feed
3. `poll()`: read collaborators' feeds → download SyncEnvelopes → add to inbox
4. Collaboration index feed — created on share, lists all collaborators' feed topics
5. Register with SyncManager in swarm-plugin.ts after sharing/import

**What we DON'T build:** merge logic, CRDTs, conflict resolution UI — DocSync handles all of this.

**Start with polling (5-10s latency)**, upgrade to GSOC/PSS later.

### 2. GSOC/PSS Real-Time Notifications

Enhance SwarmChannel with sub-second latency:

**GSOC (many-to-one notification bell):**
- On flush: send GSOC notification to each collaborator's overlay
- On receive: immediately poll that collaborator's feed
- Requires full Bee nodes

**PSS (point-to-point encrypted messaging):**
- Send SyncEnvelopes directly via PSS (encrypted for recipient's pubkey)
- Also write to own feed (persistence/recovery backup)
- Mailboxing: works even if recipient is temporarily offline
- Requires full Bee nodes

### 3. Publish Packages

Publish updated packages to npm with all current features:

| Package | Current | Registry |
|---------|---------|----------|
| `@liberuum-org/bee-reactor-adapter` | 0.19.1 | npm |
| `@liberuum-org/connect` | 6.0.0-dev.161-swarm.22 | npm |

---

## Exploratory

Future infrastructure ideas. Not blocking anything today.

### ETH Address → Signer Address Registry

Users currently share by Swarm signer ID (copy-paste). An on-chain registry (Gnosis Chain) or Swarm-native index could map ETH wallet address → signer address for auto-discovery. Needs UX design — even a one-time on-chain tx is friction. Could also use ENS text records for ENS name holders.

### ACT-Based Sharing

Replace SHA-256 shared key encryption with Swarm's native ACT (Access Control Trie). ACT handles encryption/decryption at the Bee node level. API methods already exist (`grantAccess`, `revokeAccess`). Waiting for better cross-node compatibility in bee-js.

### Mode 3: Full Swarm Deployment

Deploy the Connect SPA itself to Swarm:
- HashRouter (no server-side routing)
- ENS domain for human-readable URLs
- Fully decentralized — no servers at all

---

## Key Files

| File | Purpose |
|------|---------|
| `bee-reactor-adaptor/src/swarm-client.ts` | Bee SDK wrapper: upload, download, feeds, encryption, stamps, sharing |
| `bee-reactor-adaptor/src/swarm-crypto.ts` | AES-256-GCM encrypt/decrypt with SWE prefix |
| `bee-reactor-adaptor/src/wallet-signer.ts` | Deterministic key derivation from wallet signature |
| `bee-reactor-adaptor/src/types.ts` | All type definitions (manifests, stamps, sharing, profiles) |
| `swarm-doc-model/processors/swarm-plugin.ts` | Browser plugin: sync, recovery, sharing, folder restore, UI state |
| `packages/connect/.../swarm-storage.tsx` | Settings UI component |
