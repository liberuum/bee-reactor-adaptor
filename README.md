# Bee Reactor Adapter

Decentralized storage for [Powerhouse](https://powerhouse.io) Connect using the [Swarm](https://ethswarm.org) network. Encrypt documents with your Ethereum wallet, store them on Swarm, recover on any device with just a wallet signature, and share with other users.

**Start here** for what this integration does, which packages to use, and how sync works. For the wider **swarm-connect** checkout (upstream Powerhouse, Swarm repos, PDF references, billing), use the table below and the workspace map at [`../Readme.md`](../Readme.md).

## Swarm-connect workspace

This monorepo is the **Bee ↔ Connect glue** (adapter + forked Connect). Sibling folders sit under the same parent directory:

| What you need | Where (from this folder) |
|---------------|---------------------------|
| Full workspace map and role of each top-level folder | [`../Readme.md`](../Readme.md) |
| Upstream Powerhouse: Connect, Vetra, reactor, switchboard, design system, `ph-cli` | [`../powerhouse/`](../powerhouse/) — [Academy](https://academy.vetra.io) |
| Swarm: Bee node, `bee-js`, `bee-docs`, `swarm-cli`, examples, Book of Swarm sources | [`../swarm/`](../swarm/) |
| Offline / extracted protocol reference (PDFs + `.md` / `.json` pairs for search & tooling) | [`../swarm/pdfs/original/`](../swarm/pdfs/original/), [`../swarm/pdfs/extracted/`](../swarm/pdfs/extracted/) |
| Contributor billing document models (Powerhouse; not Swarm-specific) | [`../contributor-billing/`](../contributor-billing/) |

Published Swarm product docs: [docs.ethswarm.org](https://docs.ethswarm.org).

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`packages/adapter`](packages/adapter/) | `@liberuum-org/bee-reactor-adapter` | Core adapter: SwarmClient, SwarmChannel, encryption, feeds, stamps |
| [`packages/connect`](packages/connect/) | `@liberuum-org/connect` | Fork of Powerhouse Connect with Swarm landing page + settings UI |

## Quick Start

### Use in any Powerhouse project

```json
{
  "dependencies": {
    "@liberuum-org/bee-reactor-adapter": "0.23.0"
  },
  "overrides": {
    "@powerhousedao/connect": "npm:@liberuum-org/connect@6.0.0-dev.174-swarm.1"
  }
}
```

The adapter integrates as a native reactor `IChannel` via `createSwarmSyncBuilder()`. The Connect fork wires it into `ReactorBuilder.withSync()` at build time — Swarm remotes persist in `sync_remotes` and survive page reloads natively alongside GQL channels.

The landing page forces wallet login, the plugin syncs all drives and docs to Swarm automatically.

### Prerequisites

- A running [Swarm Desktop](https://www.ethswarm.org/build/desktop) node
- A funded postage stamp (depth 22+ for ~7.7 GB capacity)
- An Ethereum wallet (MetaMask or any Web3 wallet)

## How It Works

```
User edits document in Connect
       ↓
Reactor stores operation in local PGlite
       ↓
SyncManager detects new ordinal → populates SwarmChannel outbox
       ↓
SwarmChannel encrypts ops → uploads to Swarm /bytes → updates feed pointer
       ↓
On new device: wallet signature → same key → read feeds → download ops → replay → restored
```

### Key Features

- **AES-256-GCM encryption** — all data encrypted before leaving the browser
- **Hierarchical manifests** — user → drive → document feeds on Swarm
- **Folder structure** — preserved across sync, recovery, and sharing
- **Custom drive types** — `preferredEditor` (e.g. builder-team-admin) preserved
- **Document sharing** — encrypted drive bundles between users via Swarm IDs
- **Manifest compaction** — merges old op batches for fast recovery
- **Landing page gate** — forces wallet login before app access

## Development

```bash
# Build adapter
cd packages/adapter && npx tsc

# Build connect
cd packages/connect && bun run build

# Run tests (requires Bee node)
cd packages/adapter && pnpm test
```

### Publishing

Each package publishes independently:

```bash
cd packages/adapter && npm publish --otp=CODE
cd packages/connect && npm publish --otp=CODE --tag swarm
```

## Documentation & references

### In this monorepo

| Document | Location |
|----------|----------|
| Architecture deep-dive | [`packages/adapter/docs/architecture.md`](packages/adapter/docs/architecture.md) |
| Build plan & roadmap | [`packages/adapter/docs/build-plan.md`](packages/adapter/docs/build-plan.md) |

### Elsewhere in swarm-connect

Use the [Swarm-connect workspace](#swarm-connect-workspace) table above for sibling paths. For a single index of folders, see [`../Readme.md`](../Readme.md).
