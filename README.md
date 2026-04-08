# Bee Reactor Adapter

Decentralized storage adapter for [Powerhouse](https://powerhouse.io) Connect using [Swarm](https://ethswarm.org). Encrypts documents with your Ethereum wallet and stores them on the Swarm network. Recover all your documents on any device with just a wallet signature.

## What It Does

- Uploads Powerhouse document operations to Swarm, encrypted with a wallet-derived AES-256-GCM key
- Maintains mutable feed pointers so the latest document state is always discoverable
- Recovers all documents on a new device from just a wallet signature (same wallet = same key = same data)
- Manages postage stamps (Swarm's storage payment mechanism)
- Provides a settings UI in Connect for monitoring sync status, storage health, and stamp management

## How It Works

```
User edits document in Connect
       |
Reactor stores operation in local PGlite (Postgres in WASM)
       |
swarm-plugin.ts receives change event, buffers operation
       |  (3-second debounce)
Encrypts all buffered ops --> uploads to Swarm /bytes --> updates feed pointer
       |
On new device: wallet signature --> same key --> read feeds --> download ops --> replay --> restored
```

See [docs/architecture.md](docs/architecture.md) for the full technical deep dive covering encryption, recovery, debouncing, and drive-document relationships.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| `bee-reactor-adaptor/` | `@liberuum-org/bee-reactor-adapter` | Core adapter: SwarmClient, encryption, feeds, stamps, ACT |
| `swarm-doc-model/` | — | Connect processor plugin: sync, recovery, settings UI integration |
| `packages/connect/` | `@liberuum-org/connect` | Fork of Connect with Swarm settings tab |

## Prerequisites

- A running [Bee node](https://docs.ethswarm.org/docs/bee/installation/quick-start) (v2.7.1+ recommended)
- A funded postage stamp (depth 22+ for ~7.7 GB capacity)
- An Ethereum wallet (MetaMask or any Web3 wallet)

## Quick Start

```bash
# Install
cd bee-reactor-adaptor && pnpm install

# Run tests (requires `bee dev` running)
pnpm test

# Build
pnpm build
```

## Architecture

```
Connect (Browser)
  +-- Reactor (event-sourced operations engine)
  +-- PGlite (local Postgres in WASM for fast reads)
  +-- swarm-plugin.ts (subscribes to changes, uploads to Swarm)
  |     +-- Buffers operations per document (pendingOps)
  |     +-- Debounces manifest writes (3s per document)
  |     +-- Handles recovery on new device login
  |     +-- Exposes status to settings UI via window.ph.swarm
  +-- SwarmClient (bee-reactor-adapter)
        +-- AES-256-GCM encryption (wallet-derived key)
        +-- /bytes uploads (immutable, content-addressed)
        +-- Feed writes (mutable pointers, per-topic write lock)
        +-- Stamp management (status, top-up, expand, create)
        +-- ACT access control (for sharing)
              |
        Bee Node (localhost:1633)
              |
        Swarm Network (decentralized p2p)
```

## Encryption

All data is encrypted **before** leaving the browser. The Bee node never sees plaintext.

```
Wallet personal_sign --> keccak256 --> secp256k1 private key --> SHA-256 --> AES-256 key
```

Same wallet + same message = same key on any device. Deterministic. Portable. Survives browser clears.

## Feed Topics

| Feed | Topic Pattern | Content |
|------|--------------|---------|
| Document manifest | `ph:v2:doc:<documentId>` | Pointer to encrypted operation batches |
| User manifest | `ph:v2:user:<eth_address>` | Index of all user's documents and drives |

## Key Files

| File | Purpose |
|------|---------|
| `bee-reactor-adaptor/src/swarm-client.ts` | Bee SDK wrapper: upload, download, feeds, encryption, stamps, ACT |
| `bee-reactor-adaptor/src/swarm-crypto.ts` | AES-256-GCM encrypt/decrypt with SWE prefix detection |
| `bee-reactor-adaptor/src/wallet-signer.ts` | Deterministic key derivation from wallet signature |
| `bee-reactor-adaptor/src/types.ts` | Type definitions: manifests, stamps, entries |
| `swarm-doc-model/processors/swarm-plugin.ts` | Browser plugin: sync, recovery, debouncing, UI state |
| `packages/connect/.../swarm-storage.tsx` | Settings UI component |

## Documentation

| Document | What it covers |
|----------|---------------|
| [architecture.md](docs/architecture.md) | How the integration works end-to-end: data flow, encryption, recovery, debouncing, drive-doc relationships, reactor internals |
| [implementation-plan.md](docs/implementation-plan.md) | What's built, what's next, published packages, architecture diagram |
| [sharing-drives-docs-plan.md](docs/sharing-drives-docs-plan.md) | Plan for encrypted document sharing between users via Swarm ACT |
| [swarm-live-editing-research.md](docs/swarm-live-editing-research.md) | Research on multi-user live editing: SwarmChannel + DocSync, GSOC, PSS |

## Roadmap

- [x] Core sync and recovery (operations to Swarm, full restore from wallet)
- [x] AES-256-GCM encryption (wallet-derived, backward compatible)
- [x] Feed optimization (3s debounce, op batch accumulation, manifest-as-reference)
- [x] Multi-drive support with correct drive-document linking
- [x] Settings UI (stamp management, storage stats, sync badges, USD pricing)
- [ ] Encrypted sharing between users (ACT-based, Bee node public keys)
- [ ] SwarmChannel for DocSync (live collaborative editing via feed polling)
- [ ] GSOC/PSS real-time notifications

## Development

### Running Tests

12 E2E tests run against a live `bee dev` node:

```bash
# Terminal 1: start Bee in dev mode
bee dev

# Terminal 2: run tests
cd bee-reactor-adaptor
pnpm test
```

### Bee Dev Mode

Dev mode runs a memory-only Bee node (no blockchain, no real tokens):

```bash
bee dev
```

- Full HTTP API on port 1633
- Postage stamps work (free)
- Data stored in memory only (lost on restart)
- SOC/Feeds not supported — adapter uses /bytes mode automatically

### Buy a Test Stamp

```bash
curl -s -X POST http://localhost:1633/stamps/10000000/24 | jq .batchID
```

## License

MIT
