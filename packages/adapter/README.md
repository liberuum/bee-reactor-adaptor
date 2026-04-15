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
SyncManager detects new ordinal --> populates SwarmChannel outbox
       |
SwarmChannel encrypts ops --> uploads to Swarm /bytes --> updates feed pointer
       |
On new device: wallet signature --> same key --> read feeds --> download ops --> replay --> restored
```

See [docs/architecture.md](docs/architecture.md) for the full technical deep dive covering encryption, recovery, debouncing, and drive-document relationships.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| `packages/adapter/` | `@liberuum-org/bee-reactor-adapter` | Core adapter: SwarmClient, SwarmChannel, encryption, feeds, stamps |
| `packages/connect/` | `@liberuum-org/connect` | Fork of Connect with Swarm landing page + settings UI |

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
  +-- SyncManager (orchestrates all sync channels)
  |     +-- CompositeChannelFactory (routes by config.type)
  |     |     +-- "gql"   → GqlRequestChannel (Switchboard cloud sync)
  |     |     +-- "swarm" → SwarmChannel (Swarm decentralized sync)
  |     +-- SwarmChannel (native IChannel implementation)
  |           +-- Outbox: push ops to Swarm (encrypt + upload + feed write)
  |           +-- Inbox: pull ops from Swarm (read feed + download + decrypt)
  |           +-- Cursors persist in sync_cursors (survive page reload)
  +-- SwarmClient (bee-reactor-adapter)
  |     +-- AES-256-GCM encryption (wallet-derived key)
  |     +-- /bytes uploads (immutable, content-addressed)
  |     +-- Feed writes (mutable pointers, per-topic write lock)
  |     +-- Stamp management (status, top-up, expand, create)
  +-- Swarm Plugin (init.ts — Bee detection, stamps, wallet, events)
        +-- Exposes status to settings UI via window.ph.swarm
              |
        Bee Node (localhost:1633 or remote)
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
| Drive manifest | `ph:v2:drive:<driveId>` | Documents + folder structure for one drive |
| User manifest | `ph:v2:user:<eth_address>` | Index of all user's drives |
| Public profile | `ph:v2:profile:<address>` | Bee node public key for sharing (unencrypted) |
| Share manifest | `ph:v2:share:<sender>:<recipient>` | Shared drive bundles between users |

## Key Files

| File | Purpose |
|------|---------|
| `src/channel/swarm-channel.ts` | Native IChannel: outbox push + inbox pull via Swarm |
| `src/channel/composite-factory.ts` | Routes "gql"/"swarm" to sub-factories |
| `src/channel/create-composite-factory.ts` | `createSwarmSyncBuilder()` — wires into ReactorBuilder |
| `src/channel/add-swarm-remote.ts` | Per-drive Swarm remote registration |
| `src/channel/manifest-manager.ts` | User + drive manifest writes on Swarm |
| `src/swarm-client.ts` | Bee SDK wrapper: upload, download, feeds, encryption, stamps |
| `src/swarm-crypto.ts` | AES-256-GCM encrypt/decrypt with SWE prefix detection |
| `src/wallet-signer.ts` | Deterministic key derivation from wallet signature |
| `src/plugin/init.ts` | Browser plugin: Bee detection, stamps, wallet, events |
| `src/plugin/sharing.ts` | Cross-user encrypted sharing + import |

## Documentation

| Document | What it covers |
|----------|---------------|
| [architecture.md](docs/architecture.md) | How the integration works end-to-end: data flow, encryption, recovery, debouncing, folder structure, reactor internals |
| [build-plan.md](docs/build-plan.md) | What's built, what's next: SwarmChannel, GSOC/PSS, ETH registry, ACT sharing |

## Roadmap

- [x] Core sync and recovery (operations to Swarm, full restore from wallet)
- [x] AES-256-GCM encryption (wallet-derived, deterministic)
- [x] Feed optimization (op batch accumulation, manifest-as-reference)
- [x] Hierarchical manifests (user → drive → document feeds)
- [x] Folder structure preservation (sync, recovery, sharing)
- [x] Settings UI (stamp management, storage stats, sync badges, folder tree, USD pricing)
- [x] Encrypted document sharing between users (SHA-256 shared key, drive bundles with folder metadata)
- [x] SwarmChannel as native IChannel (push/pull via reactor SyncManager)
- [x] CompositeChannelFactory for dual GQL + Swarm sync (proper builder API, no monkey-patching)
- [x] Cursor persistence across page reloads (sync_cursors in PGlite)
- [x] Recovery from Swarm (full drive + document restore from wallet signature)
- [ ] Manifest update debouncing (reduce network round-trips per push)
- [ ] GSOC/PSS real-time notifications
- [ ] ETH address → signer address registry (on-chain, share by ETH address)

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
