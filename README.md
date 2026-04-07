# Bee Reactor Adapter

A **Swarm Bee** storage adapter for the Powerhouse Reactor. Persists operations and keyframes to the Swarm decentralized storage network while using local SQL (PGlite/PostgreSQL) as a fast read cache.

## Current Version: 0.14.0

### Connect + Swarm Integration (Browser)
Full sync and recovery working:
- **Sync**: Operations upload to Swarm `/bytes`, manifests stored in Swarm feeds
- **Recovery**: After browser data wipe, same wallet → same key → same feeds → full document state restored
- **Feed writes**: Per-topic write lock, no manual index management (Swarm best practice)
- **Topic prefix**: Configurable via `feedTopicPrefix` for feed migration

### Key Architecture Decisions
- **Feeds are append-only, write-once per index** — never pass explicit indices
- **Per-topic serialization** — prevents concurrent writers from conflicting
- **Document IDs preserved** across sync/recovery (reactor uses provided `header.id`)
- **Initial state from document model** — `reactorClient.getDocumentModelModule(type).utils.createState()`

See [`docs/feed-write-fix.md`](docs/feed-write-fix.md) for the feed write fix details and [`docs/connect-swarm-integration.md`](docs/connect-swarm-integration.md) for the full integration architecture.

## Quick Start: Add Swarm Storage to Any Powerhouse Project

### 1. Add packages to `package.json`

```json
{
  "dependencies": {
    "@liberuum-org/bee-reactor-adapter": "0.2.0",
    "@ethersphere/bee-js": "^11.1.1"
  },
  "resolutions": {
    "@powerhousedao/switchboard": "npm:@liberuum-org/switchboard@6.0.0-dev.156-swarm.3"
  }
}
```

Then install:

```bash
bun install
```

The `resolutions` field tells bun to replace `@powerhousedao/switchboard` everywhere (including inside `ph-cli`) with our Swarm-enabled fork. **No manual patching, no post-install scripts.**

### 2. Install and start a Bee dev node

Download from https://github.com/ethersphere/bee/releases/tag/v2.7.1

```bash
# macOS ARM64
curl -L -o /tmp/bee.tar.gz \
  "https://github.com/ethersphere/bee/releases/download/v2.7.1/bee-darwin-arm64.tar.gz"
cd /tmp && tar xzf bee.tar.gz
mkdir -p ~/.local/bin && mv bee ~/.local/bin/bee
export PATH="$HOME/.local/bin:$PATH"

# Start dev node (memory-only, no blockchain needed)
bee dev
```

### 3. Create `.env` with Swarm config

```bash
# Buy a test stamp (free in dev mode)
STAMP=$(curl -s -X POST http://localhost:1633/stamps/10000000/24 | jq -r .batchID)

cat > .env << EOF
SWARM_BEE_URL=http://localhost:1633
SWARM_STAMP_ID=$STAMP
SWARM_SIGNER_KEY=0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
SWARM_FEED_MODE=false
EOF
```

### 4. Start Vetra with Swarm storage

```bash
source .env && bun run vetra -- --watch
```

You'll see in the logs:

```
[switchboard] Swarm Bee adapter enabled (http://localhost:1633)
[switchboard] Swarm Bee adapter started — operations will persist to Swarm
```

**Every reactor operation now persists to the Swarm Bee network.** Create documents in Connect (http://localhost:3001) or via `switchboard-cli` and they'll be uploaded to Swarm automatically.

## Published Packages

| Package | Version | What it does |
|---------|---------|-------------|
| `@liberuum-org/bee-reactor-adapter` | `0.2.0` | Core adapter: SwarmClient, SwarmSyncReadModel, SwarmOperationStore, SwarmKeyframeStore, SwarmHydrator |
| `@liberuum-org/switchboard` | `6.0.0-dev.156-swarm.3` | Fork of `@powerhousedao/switchboard` — enables Swarm via env vars |
| `@liberuum-org/reactor` | `6.0.0-dev.156-swarm.3` | Fork of `@powerhousedao/reactor` — adds `withOperationStore()`/`withKeyframeStore()` |

## How It Works

The `SwarmSyncReadModel` implements the reactor's `IReadModel` interface and is registered via `ReactorBuilder.withReadModel()`. The reactor's `ReadModelCoordinator` calls `indexOperations()` on every registered read model whenever operations are written. Our read model uploads the operation batch to Swarm `/bytes` and updates the document's manifest.

```
Reactor write path (unchanged):
  action -> reducer -> KyselyOperationStore (local SQL)
                         |
                    JOB_WRITE_READY event
                         |
                    ReadModelCoordinator
                         |
              +----------+----------+
              |          |          |
         DocView    DocIndexer   SwarmSyncReadModel
         (SQL)      (SQL)        (uploads to Swarm /bytes)
                                  |-> manifest update
```

This approach:
- Requires **zero changes** to the reactor's internal write path
- Uses the existing `withReadModel()` extension point
- Is non-blocking — Swarm uploads are async, errors don't break the reactor
- Works with any Powerhouse project that uses `ph-cli vetra`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SWARM_BEE_URL` | Yes | Bee node API URL (e.g. `http://localhost:1633`) |
| `SWARM_STAMP_ID` | Yes | Postage stamp batch ID for uploads |
| `SWARM_SIGNER_KEY` | Yes | Private key (hex) for Swarm feed signing |
| `SWARM_FEED_MODE` | No | Set `false` for `bee dev` (default: `true`) |

When these env vars are **not set**, the switchboard behaves identically to the original — no Swarm code runs.

## Verifying Data on Swarm

After creating or mutating documents, verify they're on Swarm:

```bash
# Check Bee node for uploads (tag count increases with each upload)
curl -s http://localhost:1633/tags | jq '.tags | length'

# Inspect a specific Swarm reference
curl -s http://localhost:1633/bytes/<reference> | jq .

# Use the included inspect script
./scripts/bee-inspect.sh <reference>
```

## Running Bee in Dev Mode

Dev mode runs a **memory-only** Bee node — no blockchain, no real tokens, no network.

```bash
bee dev
```

- Full HTTP API on port 1633
- Postage stamps work (free test stamps)
- Data stored in memory only (lost on restart — good for test isolation)
- **SOC/Feeds not supported** — adapter uses `/bytes` mode automatically

### Buy a test postage stamp

```bash
curl -s -X POST http://localhost:1633/stamps/10000000/24 | jq
# {"batchID":"abc123...","txHash":"0x0000..."}
```

## CLI Scripts

Run from the `bee-reactor-adaptor/` directory with `bee dev` running:

| Command | Description |
|---------|-------------|
| `pnpm bee:health` | Check Bee node status and list stamps |
| `pnpm bee:upload-test` | Upload test JSON, download, verify round-trip |
| `pnpm bee:test-flow` | Full adapter lifecycle with Swarm reference logging |
| `./scripts/bee-inspect.sh <ref>` | Download and pretty-print any Swarm reference |

## Running Tests

12 tests run against a live `bee dev` node:

```bash
# Terminal 1
bee dev

# Terminal 2
cd bee-reactor-adaptor
pnpm test
```

### Test coverage

| Test | What it verifies |
|------|-----------------|
| SwarmClient health | Bee node connectivity |
| SwarmClient upload/download | `/bytes` round-trip |
| SwarmClient missing feed | Graceful null for non-existent manifests |
| SwarmClient manifest | Write + read document manifest |
| SwarmOperationStore write | Operations go to local SQL AND Swarm |
| SwarmOperationStore read | Reads served from local SQL cache |
| SwarmKeyframeStore write | Keyframe persistence + manifest compaction |
| SwarmSyncReadModel single batch | Upload ops when `indexOperations()` called (Switchboard pattern) |
| SwarmSyncReadModel multi batch | Multiple mutations accumulate in manifest |
| SwarmSyncReadModel multi doc | Ops for different docs in one batch create separate manifests |
| SwarmHydrator | Download 3 op batches from Swarm into fresh empty store |
| BeeReactorAdapter full flow | Write 5 ops + keyframe, hydrate fresh adapter from Swarm |

## Architecture

```
bee-reactor-adaptor/
  src/
    index.ts                      Public exports
    bee-reactor-adapter.ts        Main orchestrator (BeeReactorAdapter)
    swarm-client.ts               Bee SDK wrapper (upload, download, manifests)
    swarm-sync-read-model.ts      IReadModel: uploads ops to Swarm (Switchboard integration)
    swarm-operation-store.ts      IOperationStore: write-through to local + Swarm
    swarm-keyframe-store.ts       IKeyframeStore: write-through with manifest compaction
    swarm-hydrator.ts             Startup sync: download missing data from Swarm
    types.ts                      Config, manifest types
  tests/
    integration.test.ts           12 E2E tests against bee dev node
  scripts/
    bee-health.sh                 Check node status
    bee-upload-test.sh            Upload/download round-trip
    bee-inspect.sh                Inspect any Swarm reference
    test-adapter-flow.ts          Full adapter lifecycle with logging
```

## Deployment Modes

| Mode | App hosting | Data storage | Sync | Server needed |
|------|-------------|-------------|------|---------------|
| **Hybrid** | Vercel/Docker | PGlite + Swarm + Switchboard | DocSync via GraphQL | Yes (Switchboard) |
| **Swarm Only** | Vercel/Docker | PGlite + Swarm | Swarm feed polling | No (Bee node only) |
| **Full Swarm** | Swarm + ENS | PGlite + Swarm | Swarm feed polling | No (Bee node only) |

See `docs/implementation-plan.md` for details on each mode, Renown identity integration, and ENS deployment.

## References

- Bee releases: https://github.com/ethersphere/bee/releases
- Bee JS SDK: https://www.npmjs.com/package/@ethersphere/bee-js
- Bee API docs: https://docs.ethswarm.org/api/
- Reactor architecture: `powerhouse/packages/reactor/docs/ARCHITECTURE.md`
- Forked reactor: https://www.npmjs.com/package/@liberuum-org/reactor
- Forked switchboard: https://www.npmjs.com/package/@liberuum-org/switchboard
