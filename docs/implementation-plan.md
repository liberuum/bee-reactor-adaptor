# Bee Reactor Adapter — Status & Roadmap

## What's Built (Complete)

### Core Adapter (`@liberuum-org/bee-reactor-adapter` — v0.17.0)

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

### Connect Plugin (`swarm-doc-model/processors/swarm-plugin.ts`)

- Initializes asynchronously at processor registration (doesn't block Connect startup)
- Subscribes to ALL reactor document changes, uploads new ops to Swarm
- Multi-drive sync + recovery with correct drive names
- Debounced document manifest writes (3s per doc) + debounced user manifest (3s)
- Op batch accumulation — all ops per flush uploaded as ONE /bytes batch
- Clean manifest after recovery (prevents stale drive accumulation)
- `beforeunload` handler flushes pending manifests
- `sessionStorage` hydration guard (survives Vite HMR)
- Exposes `ph.swarm.clearStorage()`, `ph.swarm.reconnect()`, `ph.swarm.refreshBalances()`

### Connect Settings UI (`packages/connect/.../swarm-storage.tsx`)

- Loading states (spinner during init, disconnected state with setup instructions)
- Storage gauge (remaining capacity, TTL, bucket utilization with collapsible explainer)
- Document tree with sync badges (buffered/flushing/synced/error), drive grouping
- Stamp management (extend duration, expand storage, buy new stamp — with dropdown presets)
- Node wallet balances (xBZZ, xDAI) with fund instructions
- USD pricing (total stamp cost, xBZZ market price from CoinGecko)
- Tooltips (Batch ID, Depth), data uploaded counter
- Alert banners (low TTL, storage full) with actual values

### Published Packages

| Package | Version | Registry |
|---------|---------|----------|
| `@liberuum-org/bee-reactor-adapter` | 0.17.0 | npm |
| `@liberuum-org/connect` | 6.0.0-dev.157-swarm.11 | npm |
| `@liberuum-org/reactor` | (forked, with `withOperationStore`/`withKeyframeStore`) | npm |

---

## What's Next (Roadmap)

### Near Term

- [ ] **Step 1: ACT-based document sharing** — share encrypted docs with other ETH addresses using Swarm ACT + Bee node public keys. See `sharing-drives-docs-plan.md`
- [ ] **Publish Connect swarm.12** — contains latest UI fixes (tooltips, explainers, pricing, alert fixes)
- [ ] **Settings UI design polish** — match Connect aesthetic more closely

### Medium Term

- [ ] **Step 2: SwarmChannel + DocSync** — implement a `SwarmChannel` (Channel interface) that uses Swarm feeds as transport for the reactor's existing DocSync protocol. Enables live collaborative editing with 5-10s polling latency. See `swarm-live-editing-research.md`
- [ ] **Mode 2: Swarm Only** — Connect without Switchboard, full sync via Swarm feeds only

### Long Term

- [ ] **Step 3: GSOC/PSS real-time** — enhance SwarmChannel with sub-second notifications via GSOC and/or encrypted PSS messaging
- [ ] **Mode 3: Full Swarm** — Deploy Connect SPA to Swarm with HashRouter + ENS domain

---

## Key Files

| File | Purpose |
|------|---------|
| `bee-reactor-adaptor/src/swarm-client.ts` | Bee SDK wrapper, feeds, encryption, stamps, ACT |
| `bee-reactor-adaptor/src/swarm-crypto.ts` | AES-256-GCM encrypt/decrypt with SWE prefix |
| `bee-reactor-adaptor/src/wallet-signer.ts` | Deterministic key derivation from wallet signature |
| `bee-reactor-adaptor/src/types.ts` | All type definitions (manifests, stamps, entries) |
| `bee-reactor-adaptor/src/swarm-sync-read-model.ts` | Server-side read model for Swarm sync |
| `swarm-doc-model/processors/swarm-plugin.ts` | Browser-side plugin (sync, recovery, UI state) |
| `packages/connect/.../swarm-storage.tsx` | Settings UI component |
| `packages/connect/.../SettingsModal.tsx` | Swarm icon + tab registration |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Connect (Browser)                                               │
│                                                                   │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────────────┐   │
│  │  Reactor  │  │  PGlite      │  │  swarm-plugin.ts         │   │
│  │  (core)   │──│  (local DB)  │──│  - subscribes to changes │   │
│  └──────────┘  └──────────────┘  │  - uploads ops to Swarm   │   │
│                                   │  - debounced manifests    │   │
│                                   │  - recovery on login      │   │
│                                   └───────────┬──────────────┘   │
│                                               │                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  SwarmConnectPlugin (@liberuum-org/bee-reactor-adapter)   │   │
│  │  - wallet key derivation (personal_sign → keccak256)     │   │
│  │  - SwarmClient (upload, download, feeds, ACT, stamps)    │   │
│  │  - AES-256-GCM encryption (wallet-derived key)           │   │
│  └───────────────────────────┬──────────────────────────────┘   │
│                               │                                   │
└───────────────────────────────┼───────────────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Bee Node (v2.7.1)    │
                    │  localhost:1633        │
                    │  Full node, WSS, PSS  │
                    │                       │
                    │  /bytes   → immutable  │
                    │  /feeds   → mutable    │
                    │  /stamps  → postage    │
                    │  /gsoc    → messaging  │
                    │  /pss     → encrypted  │
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Swarm Network        │
                    │  (decentralized)      │
                    └───────────────────────┘
```

## Encryption

All data uploaded to Swarm is encrypted with AES-256-GCM before leaving the browser:

```
Key derivation:
  wallet.personal_sign("Authorize Swarm storage...") → signature
  keccak256(signature) → 32-byte secp256k1 private key (= Swarm signer)
  SHA-256(private_key_hex) → AES-256 key

Encryption:
  plaintext → [SWE prefix (3 bytes)][IV (12 bytes)][AES-256-GCM ciphertext + tag]

Upload:
  encrypted_bytes → Bee /bytes → content-addressed reference

Feed pattern:
  manifest JSON → encrypt → /bytes → 64-char reference → feed SOC (72 bytes)
```

Same wallet + same message = same key on any device. Survives browser clears and Bee node restarts.

## Feed Topics

| Feed | Topic Pattern | Purpose |
|------|--------------|---------|
| Document manifest | `ph:v2:doc:<documentId>` | Pointer to document's operation batches |
| User manifest | `ph:v2:user:<eth_address>` | Index of all user's documents and drives |
| Public profile | `ph:v2:profile:<eth_address>` | Public key publication (for sharing) — **planned** |
| Share manifest | `ph:v2:share:<from>:<to>` | Documents shared between two users — **planned** |
| Collaboration index | `ph:v2:collab:<docId>` | Collaborator list for live editing — **planned** |
| Per-user ops | `ph:v2:ops:<address>:<docId>` | User's SyncEnvelopes for a shared doc — **planned** |
