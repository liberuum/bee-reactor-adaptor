# Bee Reactor Adapter — Status & Roadmap

## What's Built (Complete)

### Core Adapter (`@liberuum-org/bee-reactor-adapter` — v0.19.1)

- **SwarmClient** — Bee SDK wrapper with feed mode + bytes mode, auto-detect
- **SwarmOperationStore** — write-through IOperationStore (local SQL + Swarm /bytes)
- **SwarmKeyframeStore** — write-through IKeyframeStore with manifest compaction
- **SwarmHydrator** — startup sync + polling from Swarm feeds
- **BeeReactorAdapter** — orchestrator tying it all together
- **SwarmSyncReadModel** — IReadModel that uploads ops to Swarm in production
- **SwarmConnectPlugin** — browser-side plugin (wallet key derivation, auto-reconnect)
- **Wallet Signer** — deterministic secp256k1 key from `personal_sign` + `keccak256`
- **App-layer AES-256-GCM encryption** — all uploads encrypted with wallet-derived key, auto-decrypt on download, SWE prefix detection for backward compatibility
- **Feed optimization** — debounced doc manifest writes (3s), op batch accumulation, manifest-as-reference (72-byte SOC), per-topic write lock, manifest compaction
- **ACT access control API** — `uploadData({act:true})`, `grantAccess()`, `revokeAccess()`, `createGrantees()`, `getGrantees()`
- **Stamp management** — status, top-up, expand, create, cost estimation, USD pricing via CoinGecko
- **12 E2E tests** passing against `bee dev`

### Document Sharing (v0.19.1 — NEW)

- **Public profile feed** — publishes Bee node pubkey + signer address on `{prefix}:profile:<address>` (unencrypted, discoverable)
- **Share manifest feed** — `{prefix}:share:<sender>:<recipient>` stores shared doc references
- **Encrypted shared data** — `SHA-256(sender_address:recipient_address)` derived key, AES-256-GCM encrypted
- **Batch share API** — `shareDocumentsWithUser(docIds[])` processes all docs, writes ONE clean manifest (no stale accumulation)
- **Import with drive dedup** — `importFromUser()` creates single drive, reuses on repeated imports (sessionStorage tracking)
- **Action extraction** — import extracts `.action` from ops and filters global scope (matches hydration pattern)
- **Configurable Bee URL** — reads from localStorage, `setBeeUrl()` triggers reconnect
- **`applySwarmExtensions()`** — all custom `ph.swarm.*` fields survive `plugin.start()` overwrite on reconnect
- **Address normalization** — `getOwnerAddress()` always `0x`-prefixed, `normalizeAddress()` only for `makeFeedReader` owner param, topics use `address.toLowerCase()` (preserves `0x`, matches legacy feeds)
- **Robust error handling** — `isNotFoundError` handles bee-js v11 error shapes, `readShareManifest`/`readPublicProfile` catch-all (no JSON parse crashes)

### Connect Plugin (`swarm-doc-model/processors/swarm-plugin.ts`)

- Initializes asynchronously at processor registration (doesn't block Connect startup)
- Subscribes to ALL reactor document changes, uploads new ops to Swarm
- Multi-drive sync + recovery with correct drive names
- Debounced document manifest writes (3s per doc) + debounced user manifest (3s)
- Op batch accumulation — all ops per flush uploaded as ONE /bytes batch
- Clean manifest after recovery (prevents stale drive accumulation)
- `beforeunload` handler flushes pending manifests
- `sessionStorage` hydration guard (survives Vite HMR)
- Exposes on `ph.swarm`: `clearStorage()`, `reconnect()`, `refreshBalances()`, `setBeeUrl()`, `shareDocuments()`, `importSharedDocuments()`, `lookupUser()`

### Connect Settings UI (`packages/connect/.../swarm-storage.tsx`)

- Loading states (spinner during init, disconnected state with setup instructions)
- Configurable Bee node URL with Save & Connect button
- Storage gauge (remaining capacity, TTL, bucket utilization with collapsible explainer)
- Document tree with sync badges (buffered/flushing/synced/error), drive grouping
- **Your Swarm ID** — copyable signer address for sharing
- **Share section** — checkbox tree (drive selects all children), batch share with encryption
- **Import section** — enter sender's Swarm ID, import shared docs into local drive
- Stamp management (extend duration, expand storage, buy new stamp — with dropdown presets)
- Node wallet balances (xBZZ, xDAI) with fund instructions
- USD pricing (total stamp cost, xBZZ market price from CoinGecko)
- Tooltips (Batch ID, Depth), data uploaded counter
- Alert banners (low TTL, storage full) with actual values

### Published Packages

| Package | Version | Registry |
|---------|---------|----------|
| `@liberuum-org/bee-reactor-adapter` | 0.19.1 | npm |
| `@liberuum-org/connect` | 6.0.0-dev.161-swarm.22 | npm (swarm.23 pending) |
| `@liberuum-org/reactor` | (forked, with `withOperationStore`/`withKeyframeStore`) | npm |

---

## Known Bugs

- [x] **Doc-to-drive linking in tree view** — FIXED by hierarchical manifests v2. Docs are listed inside drive manifest feeds — no more fragile `docToDrive` mapping.
- [x] **Multi-drive hydration** — FIXED by hierarchical manifests v2. Recovery reads per-drive feeds for accurate grouping. Each drive has its own manifest.
- [x] **Drive dedup on import** — improved with user manifest drive list as persistent registry. sessionStorage approach still used as fallback.
- [ ] **Connect package not published** — swarm.23 with `shareDocuments` batch API, Bee URL input, and checkbox fixes is only available via dist-copy workaround. Needs publishing.
- [ ] **Swarm propagation delays** — shared data uploaded to Alice's local Bee node may take 30s-2min to be available on Bob's remote Bee node. No retry/polling on import — user must retry manually.

---

## What's Next (Roadmap)

### Near Term

- [ ] **Publish Connect swarm.23** — batch share API, Bee URL input, checkbox tree
- [ ] **Publish adapter 0.19.1** — sharing methods, encryption, address normalization (already published)
- [x] **Fix doc-to-drive linking** — hierarchical manifests v2 (drive feeds)
- [x] **Fix multi-drive hydration** — recovery reads drive manifests
- [ ] **Settings UI design polish** — match Connect aesthetic more closely

### Medium Term

- [ ] **ETH address → signer address registry** — on-chain mapping contract on Gnosis Chain so users can share by ETH address instead of Swarm ID
- [ ] **Step 2: SwarmChannel + DocSync** — implement a `SwarmChannel` (Channel interface) that uses Swarm feeds as transport for the reactor's existing DocSync protocol. Enables live collaborative editing with 5-10s polling latency. See `swarm-live-editing-research.md`
- [ ] **Mode 2: Swarm Only** — Connect without Switchboard, full sync via Swarm feeds only

### Long Term

- [ ] **Step 3: GSOC/PSS real-time** — enhance SwarmChannel with sub-second notifications via GSOC and/or encrypted PSS messaging
- [ ] **ACT-based sharing** — replace plain encrypted sharing with Swarm ACT once cross-node compatibility improves
- [ ] **Mode 3: Full Swarm** — Deploy Connect SPA to Swarm with HashRouter + ENS domain

---

## Key Files

| File | Purpose |
|------|---------|
| `bee-reactor-adaptor/src/swarm-client.ts` | Bee SDK wrapper: upload, download, feeds, encryption, stamps, sharing |
| `bee-reactor-adaptor/src/swarm-crypto.ts` | AES-256-GCM encrypt/decrypt with SWE prefix |
| `bee-reactor-adaptor/src/wallet-signer.ts` | Deterministic key derivation from wallet signature |
| `bee-reactor-adaptor/src/types.ts` | All type definitions (manifests, stamps, sharing, profiles) |
| `bee-reactor-adaptor/src/swarm-sync-read-model.ts` | Server-side read model for Swarm sync |
| `swarm-doc-model/processors/swarm-plugin.ts` | Browser-side plugin (sync, recovery, sharing, UI state) |
| `packages/connect/.../swarm-storage.tsx` | Settings UI component |
| `packages/connect/.../SettingsModal.tsx` | Swarm icon + tab registration |

## Architecture

```
Connect (Browser)
  +-- Reactor (event-sourced operations engine)
  +-- PGlite (local Postgres in WASM for fast reads)
  +-- swarm-plugin.ts (subscribes to changes, uploads to Swarm)
  |     +-- Buffers operations per document (pendingOps)
  |     +-- Debounces manifest writes (3s per document)
  |     +-- Handles recovery on new device login
  |     +-- Share: batch upload + encrypted share manifest
  |     +-- Import: download + decrypt + replay ops
  |     +-- Exposes status to settings UI via window.ph.swarm
  +-- SwarmClient (bee-reactor-adapter)
        +-- AES-256-GCM encryption (wallet-derived key)
        +-- Share encryption (SHA-256 derived shared key)
        +-- /bytes uploads (immutable, content-addressed)
        +-- Feed writes (mutable pointers, per-topic write lock)
        +-- Stamp management (status, top-up, expand, create)
              |
        Bee Node (configurable URL, default localhost:1633)
              |
        Swarm Network (decentralized p2p)
```

## Encryption

### Personal Storage
All data uploaded to Swarm is encrypted with AES-256-GCM before leaving the browser:
```
Wallet personal_sign --> keccak256 --> secp256k1 private key --> SHA-256 --> AES-256 key
```
Same wallet + same message = same key on any device. Deterministic. Portable.

### Shared Data
Shared documents are encrypted with a key both parties can derive:
```
SHA-256(normalizeAddress(sender) + ":" + normalizeAddress(recipient)) --> 256-bit AES key
```
Third parties can't decrypt without knowing both signer addresses.

## Feed Topics

| Feed | Topic Pattern | Content |
|------|--------------|---------|
| Document manifest | `ph:v2:doc:<documentId>` | Pointer to encrypted operation batches |
| User manifest | `ph:v2:user:<0x_signer_address>` | Index of all user's documents and drives |
| Public profile | `ph:v2:profile:<0x_signer_address>` | Bee node pubkey (unencrypted, discoverable) |
| Share manifest | `ph:v2:share:<0x_sender>:<0x_recipient>` | List of shared doc references (unencrypted) |

**Note**: User and document topics include the `0x` prefix (legacy format). Profile and share topics also include `0x` for consistency. The `normalizeAddress()` function (strips `0x`) is only used for `bee.makeFeedReader()` owner parameter, never for topic strings.

---

## Scaling Syncing With Swarm

### Cost Per Document (Current)

Each document edit burst produces:
- 1 × `/bytes` upload (encrypted op batch) — ~50-200ms
- 1 × `/bytes` upload (document manifest JSON) — ~50-200ms
- 1 × feed write (72-byte SOC reference) — ~200-500ms (includes `findNextIndex`)

Then globally (debounced 3s after last doc flush):
- 1 × `/bytes` upload (user manifest JSON) — ~50-200ms
- 1 × feed write (72-byte SOC reference) — ~200-500ms

**Per document**: ~3 Bee API calls, ~300-900ms.

### Bee Node Throughput Limits

A local Bee node (v2.7.1) sustains approximately:

| Operation | Throughput | Notes |
|-----------|-----------|-------|
| `/bytes` uploads | ~50-100/sec | Content-addressed, fast |
| `/bytes` downloads | ~100-200/sec | Local cache + network |
| Feed reads | ~20-50/sec | SOC lookup |
| Feed writes | ~5-10/sec | `findNextIndex` + SOC creation + propagation |

**Feed writes are the bottleneck**: ~5-10 per second.

### Scenarios

| Scenario | Docs | Concurrent flushes | Feed writes | Est. time |
|----------|------|--------------------|-------------|-----------|
| Interactive editing | 1-5 | 1-2 | 2-4 | <3s |
| Normal session | 10-20 | 5-10 | 20-40 | 5-10s |
| Bulk import (100 docs) | 100 | 100 (all at once!) | 200+ | **30-60s+, risk of 400 errors** |
| Large scale (1000+) | 1000 | 1000 | 2000+ | **needs architecture changes** |

### The Problem: Bulk Import

When 100 docs are created rapidly, all 3s debounce timers fire simultaneously:
- 100 doc manifest flushes → 300 concurrent Bee API calls
- Feed write lock serializes per-topic, but 100 topics in parallel overloads the node
- User manifest updated 100 times (each doc flush triggers it)
- Postage stamp bucket collisions cause 400 errors

### Scaling Roadmap

#### Phase 1: Concurrent Flush Throttle (Near-term — handles ~100 docs)
- [x] **Max 5 concurrent doc flushes** — queue excess, process in order
- [ ] **Batch user manifest updates** — accumulate, write once every 5-10s instead of per-doc
- [ ] **Compaction on recovery** — if doc has >20 op batches, compact before downloading all

#### Phase 2: Hierarchical Manifests (Medium-term — handles ~1000 docs)
- [ ] **Drive-level manifests** — user manifest → drive manifests → doc manifests (less data per write)
- [ ] **Incremental recovery** — only download docs modified since last sync (`lastSynced` timestamp)
- [ ] **Parallel /bytes, serial feeds** — download all /bytes concurrently, serialize feed writes

#### Phase 3: Server-Side Indexer (Long-term — handles ~10,000+ docs)
- [ ] **Switchboard indexer** — watches Swarm feeds, maintains fast SQL index for client queries
- [ ] **Chunk-level dedup** — shared ops across similar docs only uploaded once
- [ ] **SwarmChannel + DocSync** — leverage reactor's sync protocol instead of custom feed-per-doc
