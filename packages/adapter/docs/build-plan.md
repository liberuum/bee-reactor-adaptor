# Swarm Integration — Build Plan

What's shipped and what's next for the Powerhouse Connect + Swarm
decentralized storage, sharing, and chat integration.

Paired reading:
- [`chat-roadmap-next.md`](./chat-roadmap-next.md) — prioritized follow-on work
- [`chat-collaboration-design.md`](./chat-collaboration-design.md) — end-to-end design of chat, sharing, and live collab
- [`architecture.md`](./architecture.md) — how documents flow from Connect → Swarm and back
- [`swarm-channel-architecture.md`](./swarm-channel-architecture.md) — the native IChannel sync layer

---

## What's Built

### Core Adapter (`@liberuum-org/bee-reactor-adapter`)

- **SwarmClient** — Bee SDK wrapper (feeds, /bytes, /bzz, /grantees, /pss, /gsoc, /addresses, /wallet).
- **Deterministic wallet signer** — secp256k1 key derived from `personal_sign` + `keccak256`, cached in IndexedDB.
- **AES-256-GCM encryption** — every personal upload encrypted with the wallet-derived key before it reaches the Bee node. `SWE` prefix auto-detected on download.
- **Feed optimization** — debounced manifest writes, per-topic write lock, manifest-as-reference (upload payload → write only the 64-char ref to the feed), concurrent flush throttle (max 5 parallel).
- **Stamp management** — status, top-up, expand, create, cost estimation, xBZZ/USD pricing via CoinGecko.
- **ACT access control API** — `createGrantees`, `patchGrantees`, `uploadFile({act:true, actHistoryAddress})`, `downloadFile({actPublisher, actHistoryAddress})`.
- **Node status helpers** — `/health`, `/topology`, `/addresses`, `/wallet`, `/stewardship/{ref}`.

### Hierarchical Manifests

- **User manifest** — lists drives, stamps, and known chat peers (small, rarely changes).
- **Drive manifests** — per-drive feed listing all documents + folder structure.
- **Document manifests** — per-document feed listing operation batches + keyframes.
- **Drive manifest cache** — in-memory source of truth to avoid stale reads during rapid writes.

### Folder Structure

- Folder + parentFolder tracking read from drive's `state.global.nodes` on each flush.
- Full ADD_FOLDER / MOVE_NODE recovery with proper `createAction` shape.
- Folder preservation across both recovery and cross-user share/import.
- Connect Settings renders folder hierarchy in Documents + Sharing sections.

### SwarmChannel (native IChannel implementation)

- `SwarmChannel` implements the reactor's `IChannel` interface (inbox/outbox/deadLetter).
- `CompositeChannelFactory` routes `"swarm"` and `"gql"` config types to sub-factories.
- Wired via `ReactorBuilder.withSync(syncBuilder)` — no monkey-patching.
- **Push:** SyncManager detects new ordinals → SwarmChannel encrypts → uploads to /bytes → writes feed ref.
- **Pull:** SwarmChannel polls user → drive → doc manifests → downloads batches → decrypts → adds to inbox.
- ManifestManager handles user/drive manifest writes.
- Cursor tracking in `sync_cursors` (PGlite) — survives page reload.
- Dead letters in `sync_dead_letters` — persisted, queryable, retryable.
- Bridge pattern: same drive can sync to BOTH Switchboard (GQL) AND Swarm simultaneously.

### Document Sharing (ACT-based)

- **Public profile feed** — publishes Bee node pubkey + signer address + overlay on `ph:v2:profile:<address>` (unencrypted for discovery).
- **Share manifest feed** — `ph:v2:share:<sender>:<recipient>` stores ACT-protected drive bundles.
  - `version: 2` manifests carry `actHistoryAddress`, `actGranteeRef`, and `publisherBeeNodePubKey`.
  - Legacy `version: 1` (SHA-256 derived key) supported read-only as a backward-compat fallback.
- **Drive bundle** — `{ documents, folders, docFolders, preferredEditor }`. One ACT-protected upload per drive.
- **Unified bundle builder** — `buildDriveShareBundle` is used by both Settings and in-chat sharing. Operations are sourced from the local reactor (including unflushed ops), falling back to Swarm manifest reads.
- **Signature preservation** — imported ops keep the sender's signer so authorship is correct on the recipient side.
- **Import dedup** — creates a single drive per shared drive id; reuses on repeat imports; restores folder structure.

### Chat (PSS + ACT feed history + GSOC hooks)

- **PSS 1-to-1 messaging** — mined Trojan chunks on `ph:v2:chat:<sorted(A,B)>` topic. Point-to-point, recipient-encrypted.
- **Broadcast ping** — new-conversation notification on a shared broadcast topic; auto-creates a session on receipt, dedup'd via `seenMessageIds`.
- **ACT-encrypted chat history** — `ph:v2:chatlog:<sorted(A,B)>[:chapter]` feed, paginated, both parties granted via ACT. Each page reference is stored in a 64-byte wrapper chunk (ref + history) so the recipient can reconstruct the ACT chain from the feed alone.
- **Chapter rotation** — Clear-All-Chats bumps the chapter (using `Date.now()` so it survives localStorage wipes) → the peer learns the new chapter from the first PSS message on the fresh feed → both sides read only the post-clear history.
- **Session recovery** — known peers stored in the user manifest (`chatPeers[]`) so a fresh browser rehydrates conversations from wallet + Bee alone.
- **Raw file attachments** — images, PDFs, audio, video, text. ACT-protected upload via `/bzz` with the recipient's Bee node pubkey as grantee. 200 MB cap.
- **Document share attachments** — full parity with Settings-share: same bundle shape, same ACT path, same signer-preservation guarantee. Rendered inline with `DocumentShareCard`.
- **GSOC notifier** — adapter ships `sendTyping`, `sendStoppedTyping`, `sendPresence`, plus `onNotification` subscribers. (UI is not wired to these — see roadmap.)
- **MIME detection** — 80+ extension map, plus a browser-type fallback. Video pre-flight via `canPlayType`, with a download fallback when a codec is unavailable.

### Plugin Layer (`adapter/src/plugin/`)

- `init.ts` — Bee detection, stamp auto-select, wallet key derivation, ChatManager bootstrap, UI event emission.
- `sharing.ts` — Cross-user ACT share + import, unified drive-bundle builder, public-profile publishing.
- `hydration.ts` — Folder structure restoration.
- `state.ts` — Bee URL, UI cache fields, drive mapping for the settings panel.
- `storage.ts` — `clearSwarmStorage`, `loadManifestIndex` (IndexedDB), chat-related localStorage keys.
- `events.ts` — Toast event bus (`onSwarmEvent` / `emitSwarmEvent`).

`window.ph.swarm` surface:
- **Connect/disconnect:** `setBeeUrl(url)`, `reconnect()`
- **Stamps:** `getAllStamps()`, `switchStamp(id)`, `refreshStamp()`, `refreshBalances()`
- **Sharing:** `shareDocuments(docIds, recipient)`, `importSharedDocuments(sender)`, `lookupUser(address)`
- **Chat:** `chat.manager` (the `ChatManager` instance), `clearChats()`
- **Recovery:** `clearStorage()`, `getUploadedBytes()`
- **Node info:** `getNodeStatus()`, `getBucketUtilization()`, `isContentAvailable(docId)`, `reuploadContent(docId)`

### Connect Settings UI (`swarm-settings/`)

- Configurable Bee node URL with Save & Connect.
- Storage gauge (capacity, TTL, utilization).
- Document tree with sync badges, drive grouping, folder hierarchy.
- "Your Swarm ID" — copyable signer address.
- Share section — checkbox tree, batch ACT share.
- Import section — enter sender's Swarm ID, import with folder structure.
- Stamp management (extend, expand, create new with dropdown presets).
- Node wallet balances (xBZZ, xDAI), USD pricing, alert banners.
- Data section — "Clear all local data" (local wipe; does not touch Swarm feeds).

### Connect Chat UI (`components/chat/`)

- Discord-style 2-pane chat panel (conversation list + thread + files tab).
- Three-state readiness (`waiting` → `connecting` → `ready`) so the panel never flashes "not ready" when Bee is already up.
- Conversation list with "Your Swarm ID" card, search, unread badges, and a two-step **Clear all chats** button (bumps chapter + wipes local caches + clears `chatPeers`).
- Thread with message grouping (consecutive messages within 5 min collapse).
- Composer: file attach + **document share picker** (drive selector → multi-select documents → optional caption).
- Inline previews: image / GIF, PDF iframe, audio, video (with codec pre-flight and download fallback), text.
- External Swarm link previews (`bzz://<hash>` and `https://…/bzz/<hash>`).
- Drag-and-drop uploads into the thread.
- Files tab with thumbnails + universal preview modal (portaled with `data-chat-overlay`).
- Sidebar chat icon with unread badge, driven by localStorage-backed `useUnreadCount`.

---

## What's Next

### Live Collaboration via GSOC — the only major track left

Replace the SwarmChannel's periodic polling with GSOC-triggered pulls, add
per-document presence, and broadcast cursors/selections. See
[`chat-roadmap-next.md`](./chat-roadmap-next.md) for the detailed cut, and the
upcoming `live-collaboration-design.md` for the concrete plan.

**High-level:**

- One mined GSOC signer per drive (amortize the mining cost across its docs).
- SwarmChannel subscribes to its peers' GSOC signers for `doc-updated` pings → pulls inbox on demand instead of polling every N seconds.
- Per-document presence via short-TTL GSOC updates (`collab-join` / `collab-leave`) → render viewer avatars in the document toolbar.
- Cursor/selection broadcasts via throttled GSOC messages per peer.
- Conflict handling stays free — the reactor's operation model already resolves concurrent edits.

Everything beneath — the share bundle, the ACT history, the chat history,
the Swarm channels, the manifests, the composer picker — is already built
and in use.

---

## Exploratory / Deferred

Future infrastructure ideas. Not blocking anything today.

### Typing & Presence UI

Adapter already ships `sendTyping` / `sendStoppedTyping` / `sendPresence` and
notification subscribers. **Decision (2026-04-18): not shipping a typing
indicator.** PSS has 2–10s latency; a "User is typing…" hint doesn't pay off
when the message itself takes longer than the hint. Presence dots could still
be useful (cached last-seen), but it's low priority compared to live collab.

### ETH Address → Signer Address Registry

Users currently share by Swarm signer ID (copy-paste). An on-chain registry
(Gnosis Chain) or Swarm-native index could map ETH wallet → signer address
for auto-discovery. ENS text records are a candidate for ENS holders. Needs
UX design — even a one-time on-chain tx is friction.

### Mode 3: Full Swarm Deployment

Deploy the Connect SPA itself to Swarm:
- HashRouter (no server-side routing)
- ENS domain for human-readable URLs
- Fully decentralized — no servers at all

### Group Chat

PSS is 1-to-1. Group chat would need N×(N-1) PSS channels or a shared GSOC
topic with ACT-gated feed history. Feeds can serve as the canonical group log.

### Message Edit / Delete

Feeds are append-only, so "delete" means writing a tombstone message. No UI,
no adapter flow yet.

---

## Key Files

| File | Purpose |
|------|---------|
| `adapter/src/swarm-client.ts` | Bee SDK wrapper: /bytes, /bzz, feeds, ACT, PSS, GSOC, node status |
| `adapter/src/swarm-crypto.ts` | AES-256-GCM encrypt/decrypt with SWE prefix |
| `adapter/src/wallet-signer.ts` | Deterministic key derivation from wallet signature |
| `adapter/src/stamp-manager.ts` | Postage stamp lifecycle + CoinGecko pricing |
| `adapter/src/share-manager.ts` | ACT-based cross-user sharing + public profile I/O |
| `adapter/src/types.ts` | Manifests, sharing types (with `version: 2` ACT flag), stamp status |
| `adapter/src/channel/swarm-channel.ts` | IChannel implementation: outbox push + inbox pull |
| `adapter/src/channel/composite-factory.ts` | Routes "gql"/"swarm" to sub-factories |
| `adapter/src/channel/create-composite-factory.ts` | `createSwarmSyncBuilder` for `ReactorBuilder.withSync()` |
| `adapter/src/channel/manifest-manager.ts` | User + drive manifest writes, chat-peer list management |
| `adapter/src/chat/chat-manager.ts` | PSS session orchestrator, chapter tracking, file/doc sharing |
| `adapter/src/chat/chat-history.ts` | ACT-encrypted feed pages + chapter rotation |
| `adapter/src/chat/pss-messenger.ts` | PSS send/subscribe + broadcast topic |
| `adapter/src/chat/gsoc-notifier.ts` | GSOC signer mining + notification send/subscribe |
| `adapter/src/chat/swarm-file.ts` | ACT-protected file upload + thumbnails |
| `adapter/src/chat/mime-guess.ts` | Best-effort MIME detection for attachments |
| `adapter/src/plugin/init.ts` | Bee detection, stamps, wallet, ChatManager init, `ph.swarm` surface |
| `adapter/src/plugin/sharing.ts` | Cross-user ACT share + import + `buildDriveShareBundle` |
| `connect/src/utils/reactor.ts` | Wire `CompositeChannelFactory` into `createBrowserReactor` |
| `connect/src/components/modal/modals/settings/swarm-settings/` | Settings panel |
| `connect/src/components/chat/` | Chat panel, composer, picker, previews |
