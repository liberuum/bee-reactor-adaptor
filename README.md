# Bee Reactor Adapter

Decentralized storage + encrypted chat for [Powerhouse](https://powerhouse.io)
Connect using the [Swarm](https://ethswarm.org) network. Encrypt documents
with your Ethereum wallet, store them on Swarm, recover on any device with
just a wallet signature, share drives with other users, and chat directly
peer-to-peer via PSS + GSOC — no servers.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`packages/adapter`](packages/adapter/) | `@liberuum-org/bee-reactor-adapter` | Core adapter: SwarmClient, SwarmChannel, ACT-encrypted sharing, PSS/GSOC chat, stamps |
| [`packages/connect`](packages/connect/) | `@liberuum-org/connect` | Fork of Powerhouse Connect with Swarm landing page, settings UI, and chat panel |

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

The adapter integrates as a native reactor `IChannel` via
`createSwarmSyncBuilder()`. The Connect fork wires it into
`ReactorBuilder.withSync()` at build time — Swarm remotes persist in
`sync_remotes` and survive page reloads natively alongside GQL channels.

The landing page forces wallet login, the plugin syncs all drives and docs
to Swarm automatically, and exposes the chat panel from the sidebar.

### Prerequisites

- A running **full Bee node**, reachable from your browser (chat needs
  full-node PSS + GSOC; light nodes can send but not receive).
- A funded **mutable postage stamp** (depth 22+ for ~7.7 GB capacity;
  mutable so feed updates reuse bucket slots).
- An Ethereum wallet (MetaMask or any Web3 wallet) for Renown login.
- For peer-to-peer chat, ports `1634` (TCP) and `1635` (WSS) must be open
  inbound so libp2p WebSocket transport works. The chat panel shows a
  requirements screen with the exact Bee config keys if chat can't start.

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

### Feature highlights

**Storage & recovery**
- AES-256-GCM encryption at the app layer for operations + manifests
- Hierarchical feeds: user → drive → document
- Folder topology preserved across sync, recovery, and sharing
- Manifest compaction — old op batches merged for fast recovery

**Sharing (ACT-protected)**
- Encrypted drive bundles between users via Swarm IDs
- ECDH-based access control through Swarm's native ACT — no app-layer
  shared-secret math; the Bee node handles decryption transparently

**Chat (PSS + GSOC)**
- 1-to-1 encrypted messaging via PSS with offline delivery
- Discord-style conversation UI with unread badge on the sidebar
- Persistent history in ACT-encrypted feeds, paginated backwards
- File sharing: images, GIFs, PDFs, audio, video, text — all ACT-encrypted
- External `bzz://<hash>` URL previews for files uploaded outside the chat
- Drag-and-drop uploads, inline previews, lightbox, 200 MB cap
- Pre-flight codec check for video so unplayable formats fall back to
  download cleanly instead of mid-playback failure

**Settings**
- Live chain-price fetching for stamp top-ups (no hardcoded price drift)
- Real Bee error surfacing on stamp ops (parses `BeeResponseError.responseBody`
  so users see the actual on-chain reason instead of "500")
- Bucket-utilization diagnostics with dilute / expand / top-up actions

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

All docs live under [`packages/adapter/docs/`](packages/adapter/docs/):

| Document | Scope |
|----------|-------|
| [`architecture.md`](packages/adapter/docs/architecture.md) | Storage / sync architecture deep-dive |
| [`architecture-diagram.md`](packages/adapter/docs/architecture-diagram.md) | Visual system diagrams |
| [`build-plan.md`](packages/adapter/docs/build-plan.md) | Build plan & overall roadmap |
| [`chat-collaboration-design.md`](packages/adapter/docs/chat-collaboration-design.md) | Chat + collaboration design, protocol choices, security model |
| [`chat-roadmap-next.md`](packages/adapter/docs/chat-roadmap-next.md) | What's shipped vs what's next in chat (typing/presence, document sharing UX, live collab) |
| [`swarm-channel-architecture.md`](packages/adapter/docs/swarm-channel-architecture.md) | How SwarmChannel integrates as a native reactor `IChannel` |
| [`swarm-protocol-reference.md`](packages/adapter/docs/swarm-protocol-reference.md) | Condensed reference for PSS, GSOC, ACT, feeds, stamps |
| [`multi-user-sync-design.md`](packages/adapter/docs/multi-user-sync-design.md) | Multi-user sync semantics |
| [`feed-structure-examples.md`](packages/adapter/docs/feed-structure-examples.md) | Concrete feed-layout examples |
| [`data-duplication-analysis.md`](packages/adapter/docs/data-duplication-analysis.md) | Storage duplication analysis |
| [`files-communicating-via-bee-node.md`](packages/adapter/docs/files-communicating-via-bee-node.md) | File upload paths via the Bee node |
| [`testing.md`](packages/adapter/docs/testing.md) | Testing strategy & running the suite |

Swarm product docs: [docs.ethswarm.org](https://docs.ethswarm.org).
