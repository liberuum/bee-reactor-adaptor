# Live Collaboration — Design

> Status as of 2026-04-18: **not started**. The only remaining major track.
> Chat, document sharing, ACT, and the SwarmChannel provide most of the
> primitives we need.

Paired reading:
- [`chat-collaboration-design.md`](./chat-collaboration-design.md) — Phase 4 context
- [`chat-roadmap-next.md`](./chat-roadmap-next.md) — prioritized list
- [`swarm-channel-architecture.md`](./swarm-channel-architecture.md) — the IChannel surface we'll extend
- [`swarm-protocol-reference.md`](./swarm-protocol-reference.md) — PSS vs GSOC, full-node requirements

---

## What live collaboration actually means here

Powerhouse documents are driven by **operations** and **custom editors**.
Every document model ships its own editor — visual canvases, tables, input
forms, dashboards, button grids, anything. A generic "cursor overlay" would
have to be implemented per editor and would often be meaningless (what's a
cursor on a button grid?).

So we're **not** going to do cursor tracking, caret labels, or per-document
avatar stacks. That was a misread of the goal.

What the user wants — and what the reactor already produces — is this:

- User A edits a document → reactor emits ops (`SET_MODEL_NAME`,
  `SET_AUTHOR_NAME`, etc.).
- User B has the same document open and clicks the **history** button in
  the document toolbar.
- B sees A's new revision appear in the list, stamped with A's signer
  address — `Revision 15. SET_MODEL_NAME, 0xadbA7...0BcA4, committed 13:33 UTC`.

That's the whole experience. The toolbar history view updates in real time,
signatures attribute each change to the right author, the reactor replays
ops as usual. The custom editor UI doesn't need to know anything about
collaboration.

**Live = the operation-history timeline in the toolbar updates across all
participants within a second or two, regardless of which editor is open.**

## Scope

**In:**
- Multi-writer collaboration at the **drive level** (preferred starting point
  — add/move folders, add/remove docs, plus all the per-doc operations
  inside it).
- Multi-writer collaboration at the **document level** (narrower — grants
  access to one doc only; other docs in the same drive stay private).
- ACT-gated read access for participants; each writer signs their own
  operations with their own Swarm signer.
- GSOC-triggered pulls so the history view refreshes without waiting for
  the SwarmChannel poll.
- A **Collaborate** tab in the existing chat panel to create, accept, and
  manage collaborations.

**Out:**
- Cursor tracking, caret overlays, per-editor presence indicators.
- Typing indicators — already scratched at the chat level for the same
  reason (latency beats the signal).
- Custom CRDTs — the reactor's operation model is the conflict resolver.
- Anything server-side — fully peer-to-peer via Bee nodes.

## Data model

Swarm's feed constraint: **only the owner can write to their own feed**.
Collaboration therefore can't be "one shared feed." It's a mesh of per-user
feeds that everyone reads.

### Collaboration manifest

A new Swarm feed per collaboration target, owned by the initiator:

```
Topic:  ph:v2:collab:<driveId>         (drive-level)
        ph:v2:collab:<driveId>:<docId> (doc-level)
Owner:  the collaboration initiator
```

Payload (written ACT-protected, grantees = all participants' Bee node pubkeys):

```json
{
  "kind": "drive" | "document",
  "driveId": "…",
  "documentId": "…",
  "participants": [
    { "address": "0xA…", "beeNodePublicKey": "02…", "joinedAt": "…" },
    { "address": "0xB…", "beeNodePublicKey": "02…", "joinedAt": "…" }
  ],
  "createdAt": "…",
  "version": 1
}
```

A participant joining or leaving is a new manifest revision by the initiator.
(Future: allow any participant to amend — needs either a Merkle-log or
convention where the initiator is authoritative.)

### Collab-scoped per-user feeds (new)

Personal drives stay encrypted with the wallet-derived AES key (as today).
**We don't re-encrypt existing personal feeds.** A collaboration creates a
parallel set of ACT-protected "collab" feeds so only participants can read:

```
Topic: ph:v2:collab:<collabId>:ops:<driveId>         (drive-level ops)
       ph:v2:collab:<collabId>:ops:<driveId>:<docId> (doc-level ops)
Owner: each collaborator owns their own topic(s)
ACT:   grantees = all participants' Bee node pubkeys
```

Each collaborator appends their own ops here (debounced + batched, same as
the existing SwarmChannel push). Batch payloads are ACT-protected /bytes
uploads; the feed update is a 64-byte wrapper (`actRef || actHistory`),
same pattern as chat history.

Why parallel feeds instead of ACT-wrapping the existing personal feeds:

- **Boundary clarity.** Personal drives stay private even if a drive is
  later shared. No migration of existing history.
- **ACT revocation is clean.** Removing a participant only affects the
  collab chain. The owner's personal feeds stay untouched.
- **Multi-collab on the same drive.** The same drive can be shared with
  different participant sets as separate collabs, each with its own ACT
  scope, without tangling the owner's personal history.

### Initial-state transfer

A participant who accepts an invitation needs the current state, not just
future ops. We reuse the **existing document-share bundle**:

- The invitation message carries a `shareReference` + `actHistoryAddress`
  pointing to a one-shot drive bundle (built via `buildDriveShareBundle`).
- On accept, the recipient imports the bundle → drive + folders + docs
  materialize locally with the original signatures preserved.
- After import, the recipient's SwarmChannel registers the peer feeds and
  starts pulling incremental ops.

This keeps the snapshot path and the incremental-ops path decoupled.

### Read fanout on each participant

When B accepts an invitation, B's SwarmChannel:

1. Imports the initial drive bundle (reuses `importFromUser` path).
2. Reads the collab manifest → learns the full participant list.
3. Registers pull sources for every *other* participant's collab feeds.
4. Polls each participant's collab feeds (fallback) and subscribes to each
   participant's GSOC signer for this collab (primary, sub-second).
5. Pulls new ops → `reactor.load(docId, branch, ops)` → history updates.

Ops keep the sender's signature (we already preserve
`action.context.signer.signatures` through imports, per the fix shipped
2026-04-17), so each revision is attributed to the correct author in the
toolbar history.

### Local writes: where do collaborators write?

For a drive/doc that is part of a collab, the user's reactor still produces
ops locally. Those ops need to flow to two places:

- **Their personal drive feeds** — unchanged. Still wallet-key encrypted.
  This keeps the user's cross-device recovery working.
- **Their collab feeds** — ACT-protected, so peers can read them.

Implementation: SwarmChannel gains a `collabTargets` set. For each ordinal
it would push to the personal feed, it *also* pushes to the collab feed if
the doc is in an active collab. One read of the op, two pushes.

(A future optimization: push only to the collab feed for docs that exist
*only* inside a collab — e.g., a doc imported via collab accept and never
independently owned. Out of scope for v1.)

## Phasing: drive-level first, then document-level

### Phase 1: drive-level collaboration

- Simpler mental model: "I'm collaborating on this whole drive with Alice and Bob."
- Covers the drive ops (ADD_FOLDER, MOVE_NODE, ADD_FILE) and every doc
  inside it.
- Single ACT grant per participant covers the drive manifest + all child
  doc manifests + all op batches.
- Initial target for the first ship.

### Phase 2: document-level collaboration

- Narrower: "I'm collaborating on this one doc, but keep the rest of the
  drive private."
- ACT grantee list is scoped to one doc's manifest + op batches only.
- The drive manifest itself is **not** shared — the participants see a
  free-standing doc, not its parent drive.
- Useful when the containing drive has confidential material and only one
  doc is meant for outside eyes.

## Real-time trigger: GSOC

GSOC is sub-second (no Trojan mining; direct SOC sync). Mining a signer
targeting a peer's neighborhood is ~10–30 s per (peer, collab) pair — paid
once on collab creation/join, never again.

**Protocol:**

- Participant writes a new op → SwarmChannel pushes to their feed.
- Immediately after, GSOC ping to each *other* participant's signer:

  ```json
  {
    "type": "op-committed",
    "collabId": "drive:<driveId>" | "doc:<driveId>:<docId>",
    "writerAddress": "0xA…",
    "latestIndex": { "global": 42 }
  }
  ```
- Each recipient's SwarmChannel reacts by pulling that writer's feed on
  demand (debounced ~300 ms so a burst of ops coalesces into one pull).
- The timer-based poll stays as fallback for participants who were offline
  when the ping was sent.

## UX: Collaborate tab in the Chat panel

**Why the chat panel?** It already owns: peer address resolution, public
profile lookup (Bee pubkey for ACT), multi-user picker patterns (from the
document-share picker), and notification plumbing. Adding Collaborate next
to the existing conversation list keeps everything multi-peer in one place.

### Layout

```
Chat Panel (left pane)
  ├── [Conversations] tab    ← existing
  └── [Collaborate]    tab   ← NEW
        ├── "+ New collaboration" button
        ├── Pending invitations  (I received)
        └── Active collaborations (I'm part of)
```

### Creating a collaboration

1. Click **+ New collaboration**.
2. Pick target:
   - **Drive** (shows drive list from `reactorClient`)
   - **Document** (drive → doc picker, same as the existing document-share picker)
3. Pick participants:
   - Multi-select from known chat peers.
   - Or paste a Swarm ID directly.
4. Optional caption ("Working on Q1 budget").
5. Click **Invite**.

Adapter flow:
- Create collab manifest via `createGrantees([participantPubKeys…])` then
  ACT-write manifest referencing the grantee chain.
- Mine a GSOC signer per participant (background).
- Publish invitation as a chat message with a new
  `CollabInviteAttachment`:

  ```typescript
  {
    kind: "collab-invite",
    collabId: "drive:<driveId>" | "doc:<driveId>:<docId>",
    driveId, driveName,
    documentId?, documentName?,
    manifestRef, actHistoryAddress, publisherBeeNodePubKey,
    participants: [...]
  }
  ```

### Accepting an invitation

Recipient sees a **CollabInviteCard** in chat (mirrors `DocumentShareCard`
but with a [Join] instead of [Import]).

- [Join] → adapter downloads manifest via ACT → registers SwarmChannel
  sources for each participant's feeds → kicks off the first pull →
  drive/doc materializes in the recipient's reactor.
- [Decline] → adapter removes the participant from its known-collab list
  (only a local effect; initiator's manifest still lists them until they
  update it).

### Active collaboration row

- Drive or document icon + name.
- Participant avatars (initials — these we do want; it's a list, not a
  per-editor overlay).
- Last activity timestamp.
- Click → open drive/doc in Connect.
- Menu: [Leave collaboration] → local-only leave (feed writes stop, pulls
  stop); the initiator can later remove them from the manifest.

### Where live updates are visible

- Document toolbar → **History** → revision list shows peers' ops as they
  arrive, attributed by signer address. This is the *only* live surface.
- No cursor overlays. No "X is editing" banners. No editor-level presence.

## Adapter surface

New namespace `window.ph.swarm.collab`:

```typescript
interface SwarmCollab {
  /** Create a new collab. Mines GSOC signers in the background and
   *  returns immediately. */
  create(input: {
    target: { driveId: string; documentId?: string };
    participants: string[];  // Swarm signer addresses
    caption?: string;
  }): Promise<CollabSummary>;

  /** Accept an invitation received via chat. */
  accept(inviteRef: {
    collabId: string;
    manifestRef: string;
    actHistoryAddress: string;
    publisherBeeNodePubKey: string;
  }): Promise<CollabSummary>;

  /** Locally stop participating. Future: propagate to initiator. */
  leave(collabId: string): Promise<void>;

  /** Snapshot of all collaborations the user is part of. */
  list(): CollabSummary[];

  /** Subscribe to changes (op arrived, participant joined/left). */
  on(event: "updated", handler: (s: CollabSummary) => void): () => void;
}

type CollabSummary = {
  collabId: string;
  kind: "drive" | "document";
  driveId: string;
  documentId?: string;
  participants: Array<{ address: string; displayName?: string }>;
  lastActivityAt: string;
};
```

## SwarmChannel integration

Existing SwarmChannel push/pull is per-drive. To support collaboration, each
collab registers **additional pull sources** on the SwarmChannel — one per
participant's feed(s).

```typescript
class SwarmChannel implements IChannel {
  private peerFeeds: Array<{
    participantAddress: string;
    driveFeedTopic: string;
    docFeedTopics: string[];
    cursor: number;
  }> = [];

  async registerCollab(collab: CollabSummary) {
    for (const p of collab.participants) {
      if (p.address === this.ownerAddress) continue; // skip self
      this.peerFeeds.push(/* topics derived from driveId/docIds */);
      await this.subscribePeerGsoc(p);
    }
  }

  // GSOC triggers — bypasses the poll timer
  private async onPeerOpCommitted(evt: GsocNotification) {
    await this.pullPeerFeedNow(evt.writerAddress, evt.collabId);
  }
}
```

Nothing changes about how the reactor applies ops — `reactor.load()` is
already the entry point, and it already preserves signer signatures.

## Build order

### Milestone 1 — MVP (polling, no GSOC yet)

Goal: two users, one drive, invitation → accept → B's edit appears in A's
toolbar History within ~5 s (the existing poll interval). Prove the full
loop on real Bee nodes.

1. **Types + manifest format** in `adapter/src/chat/types.ts` (or a new
   `adapter/src/collab/types.ts`): `CollabManifest`, `CollabSummary`,
   `CollabInviteAttachment`.
2. **`CollabManager`** (`adapter/src/collab/collab-manager.ts`):
   - `create({ target, participants, caption })` → builds initial share
     bundle, writes collab manifest, sends PSS invitation (chat message +
     `CollabInviteAttachment`).
   - `accept(invite)` → reads manifest, imports initial bundle via
     existing `importFromUser` path, registers pull sources.
   - `list()` / `on("updated")` — local cache of active collabs in
     localStorage, so sessions survive reload.
   - `leave(collabId)` — local-only for now (stop pushing/pulling).
3. **SwarmChannel peer-feed registration**
   (`adapter/src/channel/swarm-channel.ts`): add a `peerSources` list;
   each source has `{ participantAddress, feedTopic, cursor }`. Polling
   walks `peerSources` as well as the owner's own feeds. Each peer source
   gets its own cursor row in `sync_cursors`.
4. **Collab-scoped push path**: when a doc in an active collab flushes, the
   push pipeline ALSO writes the ACT-protected collab feed update. Reuses
   the same op-batch payload; second upload with `{ act: true }`.
5. **Chat UI — Collaborate tab** (`connect/src/components/chat/`):
   - New tab next to Conversations.
   - Empty state, pending invites, active collabs.
   - New-collab creation flow: drive/doc picker (reuse `DocumentSharePicker`
     plumbing) + participant multi-select from chat peers.
6. **`CollabInviteCard`** in the chat message pipeline. Renders inline with
   [Join] / [Decline]. Join calls `ph.swarm.collab.accept`.
7. **Toolbar History auto-refresh.** Wire the existing history view to
   re-query on inbound ops for docs the user has joined via collab. If a
   straightforward React-state refresh isn't already in place, fire a
   custom event on `reactor.load` completion and listen for it in the
   History panel.
8. **Manual smoke test**: two browsers, two Bee nodes, drive-level collab
   end-to-end. Landing criteria below.

### Milestone 2 — GSOC real-time upgrade

1. **`GsocNotifier.onOpCommitted`** — subscribe to each participant's
   signer for the collab.
2. **Send pings on push** — after a collab-feed update, fire an
   `op-committed` GSOC message to each other participant.
3. **Debounced pull on ping** — SwarmChannel pulls that writer's feeds on
   receipt, coalescing bursts (~300 ms debounce).
4. **Background signer mining** — first collab create/accept kicks off
   mining without blocking the UI; fall back to polling until mining
   completes.
5. **Latency smoke test**: peer sees new revision in History view within
   ~1–2 s of the sender committing.

### Milestone 3 — Document-level scope

1. Narrow the ACT chain to the doc's feeds only (exclude drive manifest +
   sibling docs).
2. Participant join gets just the one doc (not the containing drive).
3. UI: show "Shared document: X" in the active collab row, differentiated
   from drive-level collabs.

### Landing criteria for Milestone 1

- A invites B to collaborate on a drive → B receives a chat card with
  [Join] / [Decline].
- B clicks Join → drive materializes in B's reactor within 5 s, all
  existing docs and folders present with original signatures.
- B makes a change (edit doc, add folder) → appears in A's toolbar History
  within the poll interval, attributed to B's signer.
- A makes a change → appears in B's toolbar History the same way.
- Both users can close and reopen the browser; collab resumes from
  localStorage + the manifest.

## Testing strategy

- **Unit:** collab-manifest read/write, participant add/remove idempotency,
  GSOC routing by `collabId` / `writerAddress`.
- **Integration (two Bee nodes):** A creates drive-level collab with B,
  verifies B receives invitation via PSS, B joins, both make drive ops and
  doc ops, verify each sees the other's ops in the operation store within
  2 s (GSOC path) and within the poll interval (fallback path).
- **Signature attribution:** every revision arriving on B's side is signed
  by A's signer, and vice versa, in the toolbar history.
- **Permission boundary (doc-level collab):** A and B collaborate on doc X
  only; verify B cannot read other docs in A's drive, and verify B's
  reactor does not materialize them.
- **Offline resilience:** A goes offline, B makes 10 ops, A comes back, A
  pulls all 10 ops from B's feed (no GSOC pings arrived during offline
  window).

## Risks / unknowns

- **Signer mining time (10–30 s).** Background-mine; surface a "connecting"
  hint on the collab row; fall back to polling until mining completes.
- **Participant manifest ownership.** Only the initiator can rewrite their
  manifest feed. Adding a participant later requires them to re-write it.
  Future work: distributed manifest or "any participant may append" via a
  signed log.
- **ACT revocation.** Removing a participant requires rebuilding the ACT
  chain. Already supported (`patchGrantees`). Old content stays decryptable
  by whoever had it pre-revocation — acceptable for the drive/doc case
  (you can't unring a bell), documented in UI.
- **Full-node requirement.** Both sender and receiver need full Bee nodes
  to use GSOC. Same constraint as chat. UI degrades to polling-only for
  light nodes (slower but functional).
- **Mutable stamp requirement.** GSOC requires mutable stamps. Already the
  default in stamp selection; verify before enabling collab on a target.
- **Op bursts.** A drag-reorder on a large list could emit dozens of ops in
  a second. Coalesce GSOC pings per (peer, collab) with a ~300 ms debounce.

## Non-goals (restated)

- No cursor tracking, caret overlays, or per-editor presence.
- No CRDT. No custom merge logic.
- No server-side relay.
- No chat-level presence dots or typing indicators.
- No "save point" or "version" layer beyond the existing keyframe/operation model.
