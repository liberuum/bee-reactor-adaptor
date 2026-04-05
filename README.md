# Bee Reactor Adaptor

A **Swarm Bee** storage adapter for the Powerhouse Reactor.

## Goal

Replace the default **PGlite** (in-memory PostgreSQL) storage backend of the Powerhouse Reactor with **Swarm Bee** — a decentralized, content-addressed storage network. This makes document data sovereign, persistent, and censorship-resistant.

## Status

🔨 Research complete. Architecture mapped. Implementation in progress.

## What This Adaptor Does

The Powerhouse Reactor stores documents using an **event-sourced** architecture:
- **Operations** — append-only hash chain of mutations (like blockchain blocks)
- **Keyframes** — periodic full document snapshots for fast state reconstruction
- **Read Models** — projections built from operations (DocumentView, DocumentIndexer)

The `BeeReactorAdaptor` replaces the local PGlite storage with Swarm Bee:
- Operations → uploaded as immutable chunks to `/bytes`
- Keyframes → persisted as larger chunks with periodic uploads
- Document references → stored via **Feeds** (mutable pointers per document)
- Reactor starts → fetches feed pointers, downloads operations/keyframes from Swarm, replays to reconstruct state

## How Swarm Maps to Reactor Concepts

| Reactor Concept | Swarm Equivalent | API |
|---|---|---|
| `Operation` row | Immutable chunk (`/bytes`) | POST/GET `/bytes` |
| `Keyframe` row | Immutable chunk (`/bytes`) | POST/GET `/bytes` |
| Document pointer | Feed (`/feeds/<owner>/<topic>`) | POST/PUT/GET `/feeds/<owner>/<topic>` |
| Document lookup | ENS → Feed manifest | ENS resolve → Feed |
| Sync between reactors | Feed updates | Poll feed for latest content hash |
| Local cache | PGLite (temporary, rebuildable) | Kysely with `memory:` PGLite |

## Architecture

```
┌─────────────────────────────────────────┐
│          Powerhouse Reactor             │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │       BeeReactorStorageAdapter   │   │
│  │                                  │   │
│  │  writeOperation(op)              │   │
│  │    └→ POST /bytes (swarm chunk)  │   │
│  │    └→ POST /feeds (update ref)   │   │
│  │                                  │   │
│  │  readOperations(docId, from, to) │   │
│  │    └→ GET /feeds (get ref hash)  │   │
│  │    └→ GET /bytes (download data) │   │
│  │                                  │   │
│  │  writeKeyframe(doc, revision)    │   │
│  │    └→ POST /bytes                │   │
│  │                                  │   │
│  │  readKeyframe(doc, <= revision)  │   │
│  │    └→ GET /bytes                 │   │
│  └──────────────────────────────────┘   │
│             ↓                          │
│  ┌──────────────────────────────────┐   │
│  │     Local PGLite (cache)         │   │
│  │  - DocumentSnapshot              │   │
│  │  - DocumentIndexer              │   │
│  │  - ViewState / ProcessorCursor   │   │
│  │  - SlugMapping                   │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
             ↓
┌─────────────────────────────────────────┐
│           Swarm Bee Node                │
│   https://dappnode-tailscale:...:1633  │
│                                         │
│   /bytes    → immutable content         │
│   /feeds    → mutable references        │
│   /stamps   → postage stamps            │
│   /pss      → postal service (sync)     │
└─────────────────────────────────────────┘
```

## Implementation Order

1. **Phase 1:** Implement `BeeReactorStorageAdapter` with basic CRUD
2. **Phase 2:** Test operations upload/download to local Bee node
3. **Phase 3:** Integrate with ReactorBuilder via `withStorageAdapter(adapter)`
4. **Phase 4:** Add DocSync over Swarm feeds (feed updates between reactors)
5. **Phase 5:** Test with real vault data, benchmark performance

## Prerequisites

- Running Swarm Bee node (we have one on DappNode)
- Valid postage stamp
- `@ethersphere/bee-js` SDK
- Powerhouse repo cloned (for type imports)

## Quick Start

```typescript
import { BeeReactorAdaptor } from './src/bee-ractor-adaptor.js';

const adaptor = new BeeReactorAdaptor({
  beeApiUrl: 'http://localhost:1633',
  postageStampId: process.env.SWARM_STAMP_ID,
  feedTopic: 'reactor-operations',
});

await adaptor.writeOperation(docId, scope, branch, operation, revision);
const ops = await adaptor.readOperations(docId, scope, branch);
```

## License

MIT

## References

- Powerhouse source: `/workspace/powerhouse/packages/reactor/src/`
- Reactor docs: `/workspace/powerhouse/apps/academy/docs/academy/05-Architecture/`
- DappNode Bee endpoint: `https://dappnode-tailscale.tailcbc470.ts.net:1633/`
- TOOLS.md has all endpoints documented
