# Sharing Drives & Documents Between Users via Swarm

## Overview

Enable Alice to share encrypted documents/drives with Bob using only Bob's ETH address.
All content stays on Swarm — no centralized server required.

## Bee Node Requirements (v2.7.1+)

| Field | Description |
|-------|-------------|
| Version | `2.7.1+` (API 7.4.1+) |
| URL | `http://localhost:1633` |
| Overlay | 32-byte hex — your node's address on the Swarm network |
| Public Key | Compressed secp256k1 — used for ACT grant access |
| PSS Public Key | Compressed secp256k1 — used for encrypted PSS messaging |
| Wallet | Gnosis Chain address — holds xBZZ + xDAI for stamps |
| Stamp | Depth 22+ recommended (~7.7 GB capacity) |
| Node Type | Full node (required for GSOC/PSS reception) |
| Features | WSS enabled, PSS enabled, GSOC capable |

Key endpoints used for sharing:
- `GET /addresses` → overlay, publicKey, pssPublicKey
- `POST /gsoc/subscribe/{address}` → WebSocket for GSOC notifications
- `POST /pss/send/{topic}/{target}` → encrypted messaging
- `GET /pss/subscribe/{topic}` → WebSocket for PSS messages

## Architecture: Three Steps

```
Step 1: ACT Sharing (one-way snapshot)         <── Current target
Step 2: SwarmChannel + DocSync (live editing via polling, see swarm-live-editing-research.md)
Step 3: SwarmChannel + GSOC/PSS (real-time notifications)
```

---

## Step 1: ACT-Based Sharing (One-Way Snapshot)

### What it does
- Alice shares a document (or full drive) with Bob
- Bob receives a **copy** of all operations up to that point
- Bob imports into his own drive, encrypted with his own key
- From that point, Alice and Bob have **independent copies**

### What it does NOT do
- No real-time co-editing
- Bob's edits don't propagate to Alice
- Alice's new edits don't auto-propagate to Bob

### Key Mechanism: Swarm ACT (Access Control Trie)

Swarm's built-in encryption layer. The Bee node handles all crypto transparently.

```
Alice uploads with ACT:  uploadData(data, { act: true })
  -> returns { reference, historyAddress }

Alice grants Bob:        grantAccess(granteeRef, historyRef, [bobBeeNodePublicKey])

Bob downloads:           downloadData(reference, { actPublisher: aliceAddress, actHistoryAddress })
  -> Bob's Bee node auto-decrypts (it holds the matching private key)
```

### Prerequisites

Each user's Bee node has a secp256k1 key pair (the overlay key).
We already store `beeNodePublicKey` on the user manifest.

**Problem**: User manifests are AES-256-GCM encrypted — only the owner can read them.

**Solution**: Publish a **public profile feed** (unencrypted) so anyone can look up a user's Bee node public key by ETH address.

### Public Profile Feed

```
Topic:  ph:v2:profile:<eth_address>
Owner:  <eth_address> (the user's wallet-derived signer address)
```

Payload (JSON, uploaded unencrypted to /bytes, reference in feed):
```json
{
  "address": "0xAlice...",
  "beeNodePublicKey": "02abc123...",
  "swarmPublicKey": "03def456...",
  "updatedAt": "2026-04-08T..."
}
```

Written once on first login, updated if Bee node changes.
Anyone can read: `bee.makeFeedReader(topic, ownerAddress)` — no private key needed.

### Share Manifest Feed

```
Topic:  ph:v2:share:<sender_address>:<recipient_address>
Owner:  <sender_address>
```

Payload (encrypted with ACT, granted to recipient):
```json
{
  "from": "0xAlice...",
  "to": "0xBob...",
  "shares": [
    {
      "documentId": "abc-123",
      "documentType": "powerhouse/budget-statement",
      "name": "Q1 Budget",
      "driveId": "drive-xyz",
      "driveName": "Finance Drive",
      "reference": "fedcba987...",
      "historyAddress": "112233...",
      "operationCount": 47,
      "sharedAt": "2026-04-08T12:00:00Z"
    }
  ],
  "createdAt": "2026-04-08T..."
}
```

### Implementation Plan

#### 1. Public Profile Feed (SwarmClient)

New methods in `swarm-client.ts`:
- `publishPublicProfile(address, profile)` — write to unencrypted profile feed
- `readPublicProfile(address)` — read any user's profile by ETH address
- `profileTopic(address)` — derive topic `ph:v2:profile:<address>`

#### 2. Share Methods (SwarmClient)

New methods in `swarm-client.ts`:
- `shareDocument(docId, recipientBeeNodePubKey)` — download doc ops, re-upload with ACT, grant access, return share record
- `shareDrive(driveId, recipientBeeNodePubKey)` — share all docs in a drive
- `readShareManifest(senderAddress)` — read shares from another user's share feed
- `importSharedDocument(shareRecord)` — download ACT-encrypted data, replay ops locally
- `shareTopic(fromAddress, toAddress)` — derive topic

#### 3. New Types (types.ts)

```typescript
interface SwarmPublicProfile {
  address: string;
  beeNodePublicKey: string;
  swarmPublicKey?: string;
  updatedAt: string;
}

interface ShareManifest {
  from: string;
  to: string;
  shares: SharedDocumentEntry[];
  createdAt: string;
}

interface SharedDocumentEntry {
  documentId: string;
  documentType: string;
  name: string;
  driveId: string;
  driveName: string;
  /** ACT-encrypted reference on Swarm */
  reference: string;
  /** ACT history address (needed for download) */
  historyAddress: string;
  /** Grantee list reference */
  granteeRef: string;
  operationCount: number;
  sharedAt: string;
}
```

#### 4. Plugin Integration (swarm-plugin.ts)

- On `onReady`: publish public profile feed (once, check if exists first)
- New `shareDocumentWithUser(docId, recipientAddress)`:
  1. Read recipient's public profile → get `beeNodePublicKey`
  2. Download all op batches for the document (already decrypted)
  3. Re-upload with ACT: `uploadData(allOps, { act: true })`
  4. Grant access: `grantAccess(granteeRef, historyRef, [recipientPubKey])`
  5. Write share manifest to `ph:v2:share:<me>:<recipient>`
- New `importFromUser(senderAddress)`:
  1. Read sender's share feed
  2. Download ACT-encrypted data (Bee node auto-decrypts)
  3. Create local drive + document, replay operations

#### 5. Settings UI (swarm-storage.tsx)

- **Share button** on each document in the tree view
  - Modal: "Enter recipient's ETH address"
  - Shows recipient's profile (if found) or "User hasn't set up Swarm yet"
  - Confirm → share
- **Import section** at the bottom
  - "Import from Swarm user" — enter sender's ETH address
  - Shows list of documents shared with you
  - Select and import

### Verification

1. Alice creates a document, syncs to Swarm
2. Alice clicks Share, enters Bob's ETH address
3. System finds Bob's beeNodePublicKey from his public profile feed
4. Document is re-uploaded with ACT, access granted to Bob
5. Bob opens "Import from Swarm", enters Alice's address
6. Bob sees the shared document, imports it
7. Document appears in Bob's drive, fully decrypted and functional

---

## Step 2: SwarmChannel + DocSync (Future — see swarm-live-editing-research.md)

Build a `SwarmChannel` that implements the reactor's Channel interface.
The SyncManager handles ordering, dedup, conflict resolution — we just provide the transport.

- Each user writes SyncEnvelopes to their own Swarm op feed
- SwarmChannel polls collaborators' feeds → puts SyncEnvelopes into inbox
- SyncManager applies them to local PGlite — same as how Switchboard sync works today
- Start with polling (5-10s), upgrade to GSOC notifications later

## Step 3: GSOC/PSS Real-Time (Future)

Enhance SwarmChannel with real-time notification:
- **GSOC**: "you have new ops" bell → triggers immediate feed poll
- **PSS**: send SyncEnvelopes directly as encrypted messages between Bee nodes
- Both require full Bee nodes (already enabled on our v2.7.1 node)

See `swarm-live-editing-research.md` for full architecture and code patterns.
