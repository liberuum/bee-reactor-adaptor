# Bee Reactor Adapter

Decentralized storage for [Powerhouse](https://powerhouse.io) Connect using the [Swarm](https://ethswarm.org) network. Encrypt documents with your Ethereum wallet, store them on Swarm, recover on any device with just a wallet signature, and share with other users.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`packages/adapter`](packages/adapter/) | `@liberuum-org/bee-reactor-adapter` | Core adapter: SwarmClient, encryption, feeds, stamps, processor plugin |
| [`packages/connect`](packages/connect/) | `@liberuum-org/connect` | Fork of Powerhouse Connect with Swarm landing page + settings UI |
| [`packages/reactor`](packages/reactor/) | `@liberuum-org/reactor` | Forked reactor with `withOperationStore` / `withKeyframeStore` |
| [`packages/switchboard`](packages/switchboard/) | `@liberuum-org/switchboard` | Forked switchboard for Swarm-aware API |

## Quick Start

### Use in any Powerhouse project

```json
{
  "dependencies": {
    "@liberuum-org/bee-reactor-adapter": "0.20.0"
  },
  "overrides": {
    "@powerhousedao/connect": "npm:@liberuum-org/connect@6.0.0-dev.163-swarm.24"
  }
}
```

Register the processor:

```typescript
// processors/connect.ts
import { swarmPluginProcessorBuilder } from "@liberuum-org/bee-reactor-adapter";

export const processorFactoryBuilders = [swarmPluginProcessorBuilder];
```

That's it. The landing page forces wallet login, the plugin syncs all drives and docs to Swarm automatically.

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
swarm-plugin receives change event, buffers operation
       ↓  (3-second debounce)
Encrypts all buffered ops → uploads to Swarm /bytes → updates feed pointer
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

## Documentation

| Document | Location |
|----------|----------|
| Architecture deep-dive | [`packages/adapter/docs/architecture.md`](packages/adapter/docs/architecture.md) |
| Build plan & roadmap | [`packages/adapter/docs/build-plan.md`](packages/adapter/docs/build-plan.md) |
