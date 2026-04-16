# Chat Roadmap — What's Next

Status as of commit `e552dba` (2026-04-16). Source of truth for prioritizing
follow-on chat work. Pairs with the longer
[`chat-collaboration-design.md`](./chat-collaboration-design.md) for the
original design phases.

## Where we are

| Capability | Status | Notes |
|---|---|---|
| PSS 1-to-1 messaging | ✅ Done | [`pss-messenger.ts`](../src/chat/pss-messenger.ts), `ChatManager.sendMessage` |
| Broadcast ping for new conversations | ✅ Done | `pss.subscribeAll` + `sendBroadcastPing` |
| Feed-indexed chat history (paginated, ACT-encrypted) | ✅ Done | [`chat-history.ts`](../src/chat/chat-history.ts); both parties granted |
| Message dedup (Bee re-serve, broadcast+direct) | ✅ Done | `seenMessageIds` set, batch-trimmed |
| Raw file upload (images, PDF, audio, video, text) | ✅ Done | [`swarm-file.ts`](../src/chat/swarm-file.ts), ACT grantees cached |
| Inline previews (image / GIF / PDF iframe / audio / video / text) | ✅ Done | [`message-bubble.tsx`](../../connect/src/components/chat/message-bubble.tsx), [`files-tab.tsx`](../../connect/src/components/chat/files-tab.tsx) |
| Drag-and-drop uploads | ✅ Done | `ThreadDropZone` in `chat-panel.tsx` |
| Lightbox + universal preview modal (Files tab) | ✅ Done | portaled with `data-chat-overlay` so the chat panel stays open |
| External Swarm-link previews (`bzz://<hash>` / `https://…/bzz/<hash>`) | ✅ Done | detection in `MessageBody`, probes via `ChatManager.probeSwarmReference` |
| 200 MB upload cap | ✅ Done | `MAX_FILE_SIZE` in adapter + client guard |
| Video codec pre-flight + on-error download fallback | ✅ Done | `canPlayType` check + `onError` on `<video>` |
| Broad mime-guess coverage (MKV, FLV, 3GP, TS/MTS, WMV, VOB, etc.) | ✅ Done | [`mime-guess.ts`](../src/chat/mime-guess.ts) |
| Unread badge on sidebar chat icon | ✅ Done | `useUnreadCount` hook + custom-event dispatch |
| Document-sharing attachment type | ✅ Done | `DocumentShareAttachment` + `DocumentShareCard` (render-only) |
| `shareDocumentInChat` on the adapter | ✅ Done | builds the bundle, uploads via ACT, sends via PSS |

## What's next — three tracks, ordered by size

### A. GSOC typing & presence indicators *(smallest, highest visible UX payoff)*

The adapter has everything; the UI uses none of it.

**Adapter side (already done):**
- `GsocNotifier.sendTyping` / `sendStoppedTyping` / `sendPresence` in [`gsoc-notifier.ts`](../src/chat/gsoc-notifier.ts).
- `ChatManager.sendTyping` / `sendStoppedTyping` forward to the session's mined signer.
- `ChatManager.onNotification` subscribers receive typing/presence/delivery events.

**What to build (Connect side):**
1. **"Alice is typing…" indicator** under the thread header.
   - New state in `useChat`: `peerTyping: boolean` per active peer.
   - Subscribe in `useChat` effect: `manager.onNotification(n => if n.type === "typing" && n.from === activePeer) setTyping(true)` with a 3s auto-clear.
   - Debounced sender in `MessageInput`: on `onChange`, call `manager.sendTyping(session)` if > 1s since last send; on blur/empty, `sendStoppedTyping`.
2. **Presence in the conversation list** — green dot + "Online" or "Last seen …".
   - Cache last-seen timestamp per peer; GSOC presence events bump it.
   - Conversation row renders a small status indicator based on the cache.
3. **Delivery status** — messages currently stay `"sent"` forever. Wire the GSOC
   `message-delivered` notification to promote status to `"delivered"` when the
   peer's node acknowledges, and optionally `"read"` when the peer's chat panel
   has the conversation open.

**Estimated size:** ~150 lines across `use-chat.ts`, `message-input.tsx`,
`conversation-list.tsx`, `message-bubble.tsx`. No new adapter methods.

### B. Document-sharing UX *(medium)*

The adapter path (`shareDocumentInChat` → `DocumentShareAttachment` → render)
works end-to-end, but users can't actually trigger a share or act on a received
one.

**What to build:**
1. **"Share a document" button** in the composer (next to the paperclip).
2. **Drive/document picker modal** — reuses existing drive list; multi-select
   documents; optional text message.
3. **[Open] button** on `DocumentShareCard` — navigate to the document in
   Connect (needs the reactor router to accept a document id).
4. **[Import] / [Collaborate] button** — calls `importFromUser` to pull the
   shared drive bundle into the recipient's reactor, surfaces progress + error.
5. **Dedup / idempotency** — if the receiver already has a more recent version
   of a document, warn before overwriting.

**Estimated size:** ~400 lines (modal + picker + import flow UI +
reactor-router glue). No adapter changes.

### C. Live collaboration via GSOC *(biggest, multi-session work)*

Phase 4 from the design doc. Replaces the SwarmChannel's periodic polling with
GSOC-triggered pulls, adds per-document presence, and broadcasts
cursors/selections.

**Open design choices:**
- One GSOC signer per document, or one per drive? (Signer mining is ~10–30s.)
- Where does cursor state live — in the message pane (ephemeral) or feed
  (persistent)?
- How does presence reconcile with the existing PSS broadcast ping?

**What to build (rough cut):**
1. `SwarmChannel` listens on a per-drive GSOC signer for `document-updated`
   events; pulls inbox immediately on notification instead of every N seconds.
2. Per-document presence: set "Alice is viewing doc X" in a short-TTL GSOC
   channel; render viewer avatars in the document toolbar.
3. Cursor/selection broadcast: small GSOC messages per edit, throttled.
4. Conflict handling is already free — the reactor's operation model resolves
   concurrent edits without CRDT.

**Estimated size:** multi-session — design pass, channel refactor, presence
layer, cursor broadcast, UI polish.

## Smaller polish items (pick up any time)

- **Swarm-link previews in the Files tab** — `MessageBody` detects `bzz://`
  URLs and renders inline, but `FilesTab` only iterates `msg.attachment`.
  Extend the `files` useMemo to also sweep `msg.text` for references and
  synthesize `AttachedFile` entries.
- **Search inside messages** — current search is only in the Files tab.
- **Profile avatars** — conversation list + message bubbles use initials;
  public profile carries an optional image ref.
- **Message deletion / edit** — no UI, no adapter flow. Feeds are append-only,
  so "delete" would mean writing a tombstone message.
- **Message reactions** — small GSOC payloads keyed by message id.
- **`application/mp4` and `application/x-mp4` fallback** in `mime-guess` — rare
  servers return those instead of `video/mp4`.

## Recommended order

1. **A · typing + presence** — fastest win, users instantly feel the app is
   "alive", validates the GSOC wiring we already shipped.
2. **B · document-sharing UX** — the whole original motivation for this
   feature. Everything downstream flows through it.
3. **C · live collaboration** — tackles real-time editing, the hardest piece.
   Only start after A + B are stable in the field.
