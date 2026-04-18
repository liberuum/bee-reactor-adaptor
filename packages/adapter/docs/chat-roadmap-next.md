# Chat Roadmap — What's Next

Status as of 2026-04-18. Source of truth for prioritizing follow-on chat
and collaboration work. Pairs with the longer
[`chat-collaboration-design.md`](./chat-collaboration-design.md) for the
full design and [`live-collaboration-design.md`](./live-collaboration-design.md)
for the upcoming live-collab cut.

## Where we are

| Capability | Status | Notes |
|---|---|---|
| PSS 1-to-1 messaging | ✅ Done | [`pss-messenger.ts`](../src/chat/pss-messenger.ts), `ChatManager.sendMessage` |
| Broadcast ping for new conversations | ✅ Done | `pss.subscribeAll` + `sendBroadcastPing`, synchronous `seenMessageIds` guard |
| Feed-indexed chat history (paginated, ACT-encrypted, chapter-rotated) | ✅ Done | [`chat-history.ts`](../src/chat/chat-history.ts); both parties granted, 64-byte wrapper chunk for self-contained ACT decode |
| Chat history recovery across browser wipes | ✅ Done | `chatPeers[]` in user manifest + chapter tracking in localStorage (using `Date.now()` for wipe-safety) |
| Clear-all-chats (UI button + chapter rotation) | ✅ Done | Two-step confirm in `conversation-list.tsx` → `ph.swarm.clearChats()` bumps chapter, wipes caches, clears `chatPeers` |
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
| Document-share attachment type | ✅ Done | `DocumentShareAttachment` + `DocumentShareCard` |
| `shareDocumentInChat` on the adapter | ✅ Done | builds bundle via unified `buildDriveShareBundle`, ACT upload, PSS delivery |
| **Composer share-document button + picker modal** | ✅ Done | [`document-share-picker.tsx`](../../connect/src/components/chat/document-share-picker.tsx) — drive selector, multi-select, caption |
| **Document share via chat at parity with Settings-share** | ✅ Done | same bundle shape, full op history (including unflushed ops), original signer preserved |
| GSOC notifier (adapter) | ✅ Done | `sendTyping`, `sendStoppedTyping`, `sendPresence`, `onNotification` subscribers |
| GSOC typing/presence **UI** | ❌ Scratched | Decision 2026-04-18 — see below |
| Live collaboration via GSOC (doc-updated / presence / cursors) | ❌ Not started | Next track — see below |

## Scratched work

### Typing indicators (formerly Track A)

**Decision (2026-04-18): not shipping.** PSS message latency is 2–10 seconds
(Trojan chunk mining + push-sync). A "User is typing…" hint doesn't pay off
when the message itself arrives on a longer timescale than the hint. The
adapter hooks stay — they're useful for presence and live collab — but no UI
indicator is planned.

Presence dots (green-dot + "Last seen …") are also parked for now. Low payoff
relative to live collaboration, which delivers the real value users are
waiting for.

## What's next

### Live collaboration via ACT + GSOC

The remaining major track. Detailed plan in
[`live-collaboration-design.md`](./live-collaboration-design.md).

**What "live" means here:** both users have the document open, and when one
commits an op, the other sees it appear in the toolbar's History view
within a second or two, attributed to the correct signer. That's it. No
cursor overlays, no caret labels, no per-editor presence — Powerhouse
editors are too varied (tables, visual canvases, dashboards, button grids)
for any of that to be meaningful.

**Shape:**
- **Drive-level first, doc-level second.** Start with "collaborate on this
  whole drive" (covers ADD_FOLDER / MOVE_NODE / per-doc ops). Narrow to
  doc-level in a second pass using a tighter ACT grantee chain.
- **Per-user op feeds + collab manifest.** Each collaborator writes ops to
  their own feed (Swarm constraint — only the owner can write). A
  collaboration manifest (ACT-gated) lists participants and targets. Each
  collaborator reads every other collaborator's feeds.
- **ACT gates read access.** Removing a participant rebuilds the ACT chain
  via `patchGrantees`.
- **GSOC `op-committed` pings** replace the polling timer for active
  collabs. Debounced ~300 ms so a burst of ops triggers one pull.
- **Signatures already preserved** end-to-end (shipped 2026-04-17), so
  toolbar history shows the real author of every revision.

**UX entry point: Collaborate tab in the chat panel.** Picks drive or doc,
multi-selects participants by Swarm ID (reusing the document-share picker
pattern), sends an invitation delivered as a chat card with [Join] /
[Decline]. Active collabs list with participant avatars + last-activity
timestamp. No editor-level UI work.

**Build order:** adapter plumbing → collab manifest + ACT → SwarmChannel
peer-feed registration → GSOC pings → Collaborate tab → invitation card →
toolbar history auto-refresh → doc-level scope. See
[`live-collaboration-design.md`](./live-collaboration-design.md) for the
detail.

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
- **Group chat** — out of scope for live collab; needs its own design pass.
