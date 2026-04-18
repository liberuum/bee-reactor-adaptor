# Swarm Chat & Live Collaboration — Design Investigation

> **Implementation status (2026-04-18):**
> Phases 1, 2, and 2b (chat, document sharing, file sharing) are **shipped end-to-end**
> — adapter + UI. Phase 3 (GSOC notifier) is **shipped in the adapter**; the typing /
> presence UI on top of it is **scratched** — PSS has 2–10s latency, so a typing hint
> doesn't pay off. Phase 4 (live collaboration) is the **only remaining track**; see
> [`live-collaboration-design.md`](./live-collaboration-design.md) for the concrete plan
> and [`chat-roadmap-next.md`](./chat-roadmap-next.md) for the prioritized list.

## Goal

Add a chat + document sharing + live collaboration feature to Connect, powered
entirely by Swarm's real-time protocols (PSS, GSOC). No servers. Users communicate
directly via their Bee nodes.

---

## Available Swarm Protocols

### PSS (Postal Service over Swarm) — 1-to-1 Encrypted Messaging

| Property | Detail |
|----------|--------|
| **Direction** | One-to-one |
| **Encryption** | Asymmetric (recipient's secp256k1 public key) |
| **Max message** | ~4,060 bytes per chunk |
| **Latency** | 2–10 seconds (Trojan chunk mining + push-sync) |
| **Offline delivery** | Yes — message persists as Trojan chunk until stamp TTL expires |
| **Subscription** | WebSocket: `ws://bee:1633/pss/subscribe/{topic}` |
| **Send** | `POST /pss/send/{topic}/{target}?recipient={pubkey}` |
| **Sender node** | Full or light node |
| **Receiver node** | **Full node only** (light nodes cannot receive) |
| **Stamp type** | Mutable or immutable |

**How it works:** Sender mines a Trojan chunk whose address falls in the
recipient's neighborhood. The chunk is push-synced like regular data. Only
the recipient can decrypt it. Third parties see encrypted noise.

```typescript
// bee-js API
await bee.pssSend(batchId, topic, target, data, recipientPubKey)
const sub = bee.pssSubscribe(topic, { onMessage, onError, onClose })
```

### GSOC (Graffiti Single Owner Chunks) — Many-to-One Notifications

| Property | Detail |
|----------|--------|
| **Direction** | Many-to-one (multiple writers → one reader) |
| **Encryption** | Symmetric (shared signer key) |
| **Max message** | ~4,060 bytes per chunk |
| **Latency** | Milliseconds (no mining, uses SOC sync) |
| **Offline delivery** | Yes — SOC persists in neighborhood |
| **Subscription** | WebSocket: `ws://bee:1633/gsoc/subscribe/{address}` |
| **Send** | Via SOC upload with mined signer |
| **Receiver node** | **Full node only** |
| **Writer node** | Full or light |
| **Stamp type** | **Must be mutable** |

**How it works:** A signer key is mined whose SOC address falls in the target
node's neighborhood. This key is shared with writers. Writers create SOC updates
that sync naturally via neighborhood replication.

```typescript
// bee-js API
const signer = bee.gsocMine(targetOverlay, identifier, proximity)
await bee.gsocSend(batchId, signer, identifier, data)
const sub = bee.gsocSubscribe(address, identifier, { onMessage, onError, onClose })
```

### Key Difference: PSS vs GSOC

| | PSS | GSOC |
|---|---|---|
| **Use case** | Chat messages (private, 1-to-1) | Notifications (document updated, user typing) |
| **Latency** | 2–10s (mining) | < 1s (direct SOC) |
| **Setup cost** | None (send directly) | One-time mining (~10–30s) |
| **Encryption** | Per-message asymmetric | Shared key symmetric |

---

## Bee Node Requirements

### For Chat to Work

Both users need **full Bee nodes**. This is the hard constraint.

| Feature | Full Node | Light Node | Ultra-Light |
|---------|-----------|------------|-------------|
| PSS send | Yes | Yes | No |
| PSS receive | **Yes** | No | No |
| GSOC subscribe | **Yes** | No | No |
| GSOC send | Yes | Yes | No |
| Feed read/write | Yes | Yes | Read only |

**Minimum viable:** Both users run full Bee nodes with:
- `full-node: true`
- `swap-enable: true`
- A funded mutable postage stamp
- Connected to Gnosis Chain RPC

**Dev mode note:** PSS and GSOC work in `bee dev` mode but only within
the same node (no peers). Multi-node testing requires a real network or
a local multi-node setup.

---

## What We Already Have

### Public Profile (per user, on Swarm)

Feed topic: `ph:v2:profile:<address>`

```typescript
{
  address: "0xadbA7C2F...",       // Swarm signer address
  ethAddress: "0x...",            // Original ETH wallet (optional)
  beeNodePublicKey: "02abc...",   // Compressed secp256k1 — for PSS targeting
  swarmPublicKey: "03def...",     // Wallet-derived — for ECDH key agreement
  overlayAddress: "abc123...",    // Bee overlay — for PSS/GSOC addressing
  updatedAt: "2026-04-15T..."
}
```

**This is exactly what PSS needs:** the `beeNodePublicKey` is the PSS recipient
key, and the `overlayAddress` is the PSS target for routing.

### Share Infrastructure (ACT-protected)

- `shareDocuments(docIds, recipientAddress)` — ACT-protected upload, grants recipient's Bee node access
- `importSharedDocuments(senderAddress)` — ACT download, Bee node handles ECDH decryption
- `lookupUser(address)` — read public profile from Swarm (includes `beeNodePublicKey` for ACT)
- Share manifest at feed `ph:v2:share:<sender>:<recipient>` (unencrypted — discovery index)
- Encryption: **Swarm ACT** — ECDH(publisher_privkey x grantee_pubkey), handled transparently by Bee node
- Grantee management: `createGrantees()`, `patchGrantees()` for add/revoke access

### Sidebar (`sidebar.tsx`)

- `<ConnectSidebar>` with drive list, settings button, user avatar
- Hooks: `useUser()`, `useDrives()`, `useSelectedDriveSafe()`
- User identity: `user.address`, `user.ens?.name`, `user.profile?.userImage`

---

## Architecture Design

### Protocol Selection per Feature

| Feature | Protocol | Why |
|---------|----------|-----|
| Chat messages | **PSS** | End-to-end encrypted, 1-to-1, async delivery |
| Typing indicators | **GSOC** | Low latency (< 1s), ephemeral |
| Document share notification | **GSOC** | Instant notification when share is ready |
| Live collaboration signals | **GSOC** | Sub-second cursor/selection sync |
| Operation sync (collaboration) | **Feeds + GSOC notify** | Persistent ops via feeds, GSOC triggers pull |

### Chat Message Flow

```
Alice                                   Bob
  │                                       │
  │  1. lookupUser(bobAddress)            │
  │  → gets Bob's beeNodePublicKey        │
  │  → gets Bob's overlayAddress          │
  │                                       │
  │  2. pssSend(chatTopic, target, msg,   │
  │     bobPubKey)                        │
  │  ────────────────────────────────►    │
  │     Trojan chunk mined + pushed       │
  │                                       │
  │                                       │  3. pssSubscribe(chatTopic)
  │                                       │  ← receives decrypted message
  │                                       │
  │  4. Also write to chat feed           │
  │     (persistent history)              │
  │                                       │
  │  ◄────────────────────────────────    │
  │     Bob replies via PSS               │
```

### Topic Convention

```
Chat topic:    ph:v2:chat:<sorted(alice, bob)>
GSOC notify:   ph:v2:notify:<targetAddress>
Collab topic:  ph:v2:collab:<documentId>:<sorted(alice, bob)>
Chat history:  ph:v2:chatlog:<sorted(alice, bob)>  (feed, append-only)
```

Sorting addresses ensures both parties derive the same topic regardless
of who initiates.

### Chat History Persistence

PSS messages are ephemeral (expire with stamp TTL). For persistent chat
history, messages are also written to an **ACT-protected feed**:

```
Feed: ph:v2:chatlog:<sorted(alice, bob)>
Encryption: Swarm ACT — both parties' Bee node public keys added as grantees
Each entry: { from, text, timestamp, attachments? }
```

Each user uploads their messages to the feed with `{ act: true }`. Both
users' Bee node public keys are added as grantees via `createGrantees()`.
The Bee node handles ECDH decryption transparently — no app-level keys.
History survives node restarts and stamp expiration.

### Document Sharing in Chat

When a user shares a document in chat, three things happen:

1. **Share bundle** — existing `shareDocuments()` creates the encrypted bundle on Swarm
2. **Chat message** — PSS message with type "share" + reference to the bundle
3. **GSOC notification** — instant ping so recipient's UI updates immediately

```typescript
// Chat message with document attachment
{
  type: "share",
  text: "Check out this invoice",
  timestamp: "2026-04-15T18:30:00Z",
  attachment: {
    kind: "document-share",
    driveId: "96ffdf26-...",
    driveName: "Q1 Invoices",
    shareReference: "abc123...",  // Swarm ref to encrypted bundle
    documents: [
      { id: "b9e4fe2e-...", name: "Invoice #42", type: "powerhouse/document-model" }
    ]
  }
}
```

### Live Collaboration Flow

For real-time collaborative editing within a document:

```
Alice opens doc                          Bob opens same doc
  │                                       │
  │  1. Mine GSOC signer for Bob's        │
  │     overlay (one-time, ~10-30s)       │
  │                                       │  1. Mine GSOC signer for Alice's
  │                                       │     overlay (one-time)
  │  2. Exchange GSOC signers via PSS     │
  │  ──────────────────────────────►      │
  │  ◄──────────────────────────────      │
  │                                       │
  │  3. Alice edits → reactor creates op  │
  │     → SwarmChannel pushes to feed     │
  │     → GSOC notify to Bob (< 1s)      │
  │  ─────────GSOC────────────────►      │
  │                                       │  4. Bob's SwarmChannel pulls
  │                                       │     new ops from Alice's feed
  │                                       │
  │  ◄─────────GSOC────────────────      │  5. Bob edits → pushes to feed
  │  Alice pulls Bob's new ops            │     → GSOC notify to Alice
  │                                       │
  │  Conflict resolution: reactor's       │
  │  operation model handles concurrent   │
  │  edits via skip/noop/merge            │
```

**Key insight:** The reactor's operation-based model already handles
concurrent edits. Each user's operations are independent event streams.
The SwarmChannel's inbox pull applies remote ops via `reactor.load()`,
which handles ordering and conflict resolution.

### GSOC Notification Payload

Small payload (< 4KB) to trigger pull:

```typescript
{
  type: "doc-updated",
  documentId: "b9e4fe2e-...",
  driveId: "96ffdf26-...",
  fromAddress: "0xadbA7C2F...",
  latestIndex: { document: 5, global: 12 },
  timestamp: "2026-04-15T18:30:05Z"
}
```

Receiver's SwarmChannel reads the feed and pulls only new batches.

---

## UI Integration

### Sidebar Chat Button

```
ConnectSidebar
  ├── [User Avatar / ENS] ← existing
  ├── [Settings]           ← existing
  ├── [Chat] ← NEW — opens chat panel
  ├── ──────────────
  └── [Drive list]         ← existing
```

### Chat Panel (slide-out or route)

```
┌──────────────────────────────────────┐
│  Conversations                  [+]  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ 🟢 alice.eth (0xab...cd)      │  │
│  │   "Check out this invoice" 2m  │  │
│  ├────────────────────────────────┤  │
│  │ 🔴 bob.eth (0x12...34)        │  │
│  │   Shared "Q1 Report" 1h       │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ Start new conversation         │  │
│  │ Enter Swarm ID or ENS name... │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘

┌──────────────────────────────────────┐
│  ← alice.eth                   [⋮]  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  alice: Hey, here's the draft │  │
│  │  ┌──────────────────────────┐ │  │
│  │  │ 📄 Invoice #42           │ │  │
│  │  │ powerhouse/document-model│ │  │
│  │  │ [Open] [Collaborate]     │ │  │
│  │  └──────────────────────────┘ │  │
│  │                       2:30 PM │  │
│  ├────────────────────────────────┤  │
│  │  you: Looks good, editing now │  │
│  │                       2:31 PM │  │
│  ├────────────────────────────────┤  │
│  │  🔄 alice is editing          │  │
│  │  Invoice #42...               │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ Type a message...     [📎][▶] │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

### Document Collaboration Indicator

When live collaboration is active on a document, the document editor
shows presence indicators:

```
┌─────────────────────────────────────────────────┐
│  Invoice #42                 👤 alice 👤 bob    │
│  ─────────────────────────────────────────────  │
│  Live: 2 collaborators       [Stop Collaborating]│
│                                                  │
│  ... document editor content ...                 │
└─────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: PSS Chat (1-to-1 messaging) — ✅ shipped

**New adapter code:**
- `src/chat/pss-messenger.ts` — PSS send/receive wrapper
- `src/chat/chat-history.ts` — feed-based persistent history
- `src/chat/types.ts` — message types, conversation types

**New connect code:**
- `src/components/chat/chat-panel.tsx` — main chat UI
- `src/components/chat/conversation-list.tsx` — conversation list
- `src/components/chat/message-thread.tsx` — message display
- `src/components/chat/message-input.tsx` — compose + attach
- Sidebar integration: chat button + unread badge

**Requires:**
- Both users have full Bee nodes
- Public profiles published (for PSS keys + overlay address)
- Mutable postage stamp

**Estimated message latency:** 2–10 seconds (PSS mining)

### Phase 2: Document Sharing in Chat — ✅ shipped

**Extends existing sharing:**
- Reuses `shareDocuments()` / `importSharedDocuments()` via a unified
  `buildDriveShareBundle()` in [`plugin/sharing.ts`](../src/plugin/sharing.ts).
- Chat message carries a `DocumentShareAttachment` → rendered as
  `DocumentShareCard` inline in the thread.
- Composer has a **share-document button** wired to
  [`document-share-picker.tsx`](../../connect/src/components/chat/document-share-picker.tsx):
  drive selector → multi-select documents → optional caption → Share.
- `[Import]` on the card pulls the bundle via ACT and applies it to the
  recipient's reactor, preserving the sender's signatures on every op.
- Same bundle shape, same ACT path, same signer-preservation guarantee as the
  Settings share panel — full parity.

**No new protocols needed** — uses existing share infrastructure + PSS.

### Phase 2b: File Sharing in Chat — ✅ shipped

Not in the original design; added during implementation. Raw-file sharing
(images, PDFs, audio, video, text) with:
- ACT-encrypted upload via `/bzz` with grantee list of both parties
- `FileAttachment` type + inline preview cards per mime type
- Drag-and-drop zone in the thread
- Files-tab grid with thumbnails and universal preview modal
- Click-to-load video with pre-flight `canPlayType` check + download fallback
- External `bzz://<hash>` link previews that route through the same render
  path (no ACT, public content, badged as such)
- 200 MB cap, matching client + adapter guards, broad mime-guess coverage

### Phase 3: GSOC Notifications — ⚠️ adapter done, UI scratched

**Adapter ships:**
- [`src/chat/gsoc-notifier.ts`](../src/chat/gsoc-notifier.ts) — `mineSigner`,
  `send`, `subscribe` + notification types: typing, stopped-typing,
  presence-online/offline, message-delivered, message-read, doc-updated,
  collab-join, collab-leave.
- `ChatManager.sendTyping` / `sendStoppedTyping` / `sendPresence` +
  `onNotification` for UI subscribers.

**UI decision (2026-04-18) — typing indicator not shipping.** PSS message
latency is 2–10s; a "User is typing…" hint doesn't pay off when the message
itself arrives on a slower timescale than the hint. Presence dots and
delivery/read receipts are also parked for now.

**Where the GSOC plumbing goes instead:** live collaboration (Phase 4).
Doc-update pings, collab-join/leave, and cursor broadcasts are all what this
infrastructure was really for — sub-second collaboration signals, not
message-level UI hints.

### Phase 4: Live Collaboration — ❌ not started (next up)

**Model:** multi-writer on a drive or a single document, with ACT gating
read access. Each collaborator writes ops to their own feeds; everyone reads
everyone else's. GSOC pings trigger immediate pulls.

**The only live surface is the document toolbar's History view.** Powerhouse
editors are too varied (tables, visual canvases, dashboards, button grids)
to support meaningful cursors or per-editor presence. Instead, peers' ops
arrive in the existing op history timeline, attributed to the correct signer.

**Extend SwarmChannel:**
- Register additional pull sources for each collaborator's per-user feeds.
- GSOC-triggered pulls on `op-committed`, debounced.
- Timer-based poll remains as fallback.

**UX:** a new **Collaborate** tab in the chat panel (next to Conversations)
— pick a drive or document, multi-select participants by Swarm ID, send an
invitation that arrives as a chat card with [Join] / [Decline].

**Conflict resolution:** already handled by the reactor's operation model.
Each user produces independent operation streams; `reactor.load()` applies
remote ops with proper ordering. No CRDT.

**Next-step doc:** [`live-collaboration-design.md`](./live-collaboration-design.md)
walks the data model (collab manifest + per-user op feeds), the ACT strategy
(drive-level first, doc-level narrow later), the adapter surface
(`ph.swarm.collab`), and the Collaborate tab UX.

---

## Open Questions

1. **ENS resolution:** Can we resolve ENS names to Swarm signer addresses?
   The mapping is: ETH address → wallet signature → Swarm signer address.
   ENS resolves to ETH address, but deriving the Swarm address requires
   the target user to have published their profile with `ethAddress` field.
   Solution: lookup by ETH address in public profiles.

2. **Message ordering:** PSS doesn't guarantee order. Chat history feed
   provides canonical ordering. Display optimistically, reconcile from feed.

3. **Group chat:** PSS is 1-to-1. Group chat would need N×(N-1) PSS
   channels or a shared GSOC topic. Feeds can serve as the canonical
   group history. Consider for Phase 5.

4. **Offline messages:** PSS messages persist as Trojan chunks (until stamp
   expires). Chat history feed persists indefinitely. Need to reconcile
   PSS inbox with feed history on reconnect.

5. **Key rotation:** If a user re-derives their Swarm key (new wallet or
   cleared cache), their PSS public key changes. Need a mechanism to
   detect and re-exchange keys.

---

## Security Model: ACT vs Legacy deriveShareKey

### The vulnerability (fixed)

The original sharing used `SHA-256(sender_address + ":" + recipient_address)` as
the encryption key. Both addresses are public (on-chain, ENS, etherscan), so any
third party who knows both addresses could derive the same key and decrypt all
shared content. This was **security theater**.

### The fix: Swarm ACT (Access Control Trie)

ACT uses **ECDH** (Elliptic Curve Diffie-Hellman):
```
session_key = SHA-256(ECDH(publisher_privkey, grantee_pubkey) || salt)
```

This requires the publisher's **private key** — which only their Bee node has.
Even knowing both public keys, a third party cannot derive the session key.

| | Old (deriveShareKey) | New (ACT) |
|---|---|---|
| Key derivation | `SHA-256(public_addr_a + public_addr_b)` | `ECDH(privkey × pubkey) + salt` |
| Third party attack | Trivial — both addresses public | Impossible — discrete log problem |
| Encryption | App-level AES-256-GCM | Bee node handles natively |
| Grantee management | None | Add/remove via `patchGrantees()` |
| Revocation | Impossible | Rebuild ACT with new access key |

### What uses ACT

- **Document sharing** — drive bundles between users (`shareDocuments`)
- **Chat history feeds** — persistent message log between two users
- **Collaboration data** — any multi-party encrypted content

### What does NOT use ACT (by design)

- **Personal data** (user manifest, doc manifests, operation batches) — encrypted
  with wallet-derived AES key. Single-user, private key required. ACT not needed.
- **Public profiles** — intentionally unencrypted for user discovery.
- **Share manifests** — intentionally unencrypted (discovery index listing what
  was shared). The actual data at the referenced hashes IS ACT-protected.
- **PSS messages** — use PSS's own asymmetric encryption (recipient's Bee pubkey).

---

## Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| `@ethersphere/bee-js` PSS API | Available (v11+) | `pssSend`, `pssSubscribe`, `pssReceive` |
| `@ethersphere/bee-js` GSOC API | Available (v11+) | `gsocMine`, `gsocSend`, `gsocSubscribe` |
| `@ethersphere/bee-js` ACT API | Available (v11+) | `createGrantees`, `patchGrantees`, upload/download with `act: true` |
| ACT sharing (replaces deriveShareKey) | **Done** | ShareManager rewritten, 105/105 tests pass |
| Public profile with overlay | Already published | `beeNodePublicKey` + `overlayAddress` in profile |
| Full Bee node (both users) | **Hard requirement** | Light nodes cannot receive PSS/GSOC |
| Mutable stamp | Already available | Current stamp selection prefers mutable |
| Chat history feed | **New** | Append-only ACT-encrypted feed |
| GSOC signer mining | **New** | One-time per peer pair (~10-30s) |
