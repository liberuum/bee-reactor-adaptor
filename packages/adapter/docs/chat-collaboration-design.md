# Swarm Chat & Live Collaboration — Design Investigation

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

### Share Infrastructure

- `shareDocuments(docIds, recipientAddress)` — encrypt + upload drive bundle
- `importSharedDocuments(senderAddress)` — download + decrypt shared bundles
- `lookupUser(address)` — read public profile from Swarm
- Share manifest at feed `ph:v2:share:<sender>:<recipient>`
- Encryption: `SHA-256(sender + ":" + recipient)` → AES-256-GCM shared key

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
history, messages are also written to a **shared feed**:

```
Feed: ph:v2:chatlog:<sorted(alice, bob)>
Encryption: SHA-256(alice + ":" + bob) — same key as share channel
Each entry: { from, text, timestamp, attachments? }
```

Both users can read/write this feed using the deterministic shared key.
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

### Phase 1: PSS Chat (1-to-1 messaging)

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

### Phase 2: Document Sharing in Chat

**Extend existing sharing:**
- Reuse `shareDocuments()` / `importSharedDocuments()`
- Add chat message type "share" with attachment metadata
- Inline document preview cards in chat
- "Open" button navigates to document in Connect
- Share history visible in conversation

**No new protocols needed** — uses existing share infrastructure + PSS.

### Phase 3: GSOC Notifications

**New adapter code:**
- `src/chat/gsoc-notifier.ts` — mine signers, send/receive notifications
- Notification types: typing, document-updated, user-online, user-offline

**Enables:**
- Typing indicators (< 1s latency)
- Instant document update notifications
- Online/offline presence
- Replaces SwarmChannel's polling with event-driven pull

### Phase 4: Live Collaboration

**Extend SwarmChannel:**
- GSOC-triggered inbox pull (instead of polling)
- Per-document collaboration sessions
- Presence: who has a document open
- Cursor/selection broadcasting via GSOC

**Conflict resolution:**
- Already handled by reactor's operation model
- Each user produces independent operation streams
- `reactor.load()` applies remote ops with proper ordering
- No CRDT needed — the reactor IS the conflict resolver

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

## Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| `@ethersphere/bee-js` PSS API | Available (v11+) | `pssSend`, `pssSubscribe`, `pssReceive` |
| `@ethersphere/bee-js` GSOC API | Available (v11+) | `gsocMine`, `gsocSend`, `gsocSubscribe` |
| Public profile with overlay | **Needs extension** | Add `overlayAddress` to profile publish |
| Full Bee node (both users) | **Hard requirement** | Light nodes cannot receive PSS/GSOC |
| Mutable stamp | Already available | Current stamp selection prefers mutable |
| Chat history feed | **New** | Append-only encrypted feed |
| GSOC signer mining | **New** | One-time per peer pair (~10-30s) |
