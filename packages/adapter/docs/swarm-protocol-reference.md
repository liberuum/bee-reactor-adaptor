# Swarm Protocol Reference for the Bee Reactor Adapter

Compiled from: Book of Swarm, Swarm Whitepaper, Protocol Spec, Bee v2.7.1 source code, bee-js SDK, and official docs. This document is the single reference for understanding how our adapter interacts with Swarm and what capabilities are available.

---

## 1. Chunks and Content Addressing

Everything on Swarm is a **4KB chunk**. There are two types:

### Content Addressed Chunks (CAC)

- Max payload: 4096 bytes
- Address = `Keccak256(span || BMT_root(payload))` where span is 8 bytes (total data length)
- Self-verifying: anyone can recompute the address from the data
- Files larger than 4KB form a **hash tree**: leaf chunks hold data, intermediate chunks hold 128 child references (32 bytes each), producing a Merkle tree. The root chunk's address is the file's reference.
- Encrypted files: branching factor drops to 64 (each ref = 64 bytes: 32-byte address + 32-byte decryption key)

### Single Owner Chunks (SOC)

- Address = `Keccak256(identifier || owner_address)`
- Content: 32-byte identifier + 65-byte signature (r,s,v) + span + payload
- Only the owner (private key holder) can write; anyone can read
- SOCs provide a **virtual namespace per Ethereum account** — the owner controls what lives at each identifier
- A SOC can **wrap** a CAC (the SOC payload is the CAC's span + data)

**API endpoints:** `POST /bytes` (upload), `GET /bytes/{ref}` (download), `POST /chunks` (raw chunk), `GET /chunks/{addr}`

**bee-js:** `bee.uploadData()`, `bee.downloadData()`, `bee.uploadChunk()`, `bee.downloadChunk()`

### What our adapter does

We upload encrypted JSON (operation batches, manifests) via `POST /bytes`. The data is chunked automatically by the Bee node. We never interact with raw chunks directly.

### Optimization opportunity

For large documents with many operations, we could use the **WebSocket chunk stream** (`WS /chunks/stream`) for parallel uploads instead of sequential `/bytes` calls. This would improve throughput for bulk recovery or initial sync.

---

## 2. Feeds

Feeds are **mutable pointers** built on SOCs. A feed is a sequence of SOCs with predictable addresses.

### How they work

- Feed address = `Keccak256(Keccak256(topic || index) || owner_address)`
- Topic: arbitrary 32 bytes (we use `ph:v2:doc:<docId>`, `ph:v2:drive:<driveId>`, etc.)
- Index: sequential integer or epoch-based timestamp
- Only the owner can write updates; anyone knowing owner + topic can read
- The feed payload is typically an 8-byte timestamp + 32-byte Swarm reference

### Indexing schemes

| Scheme | How it works | Best for |
|--------|-------------|----------|
| **Sequential** | Index 0, 1, 2, ... Simple incrementing integer | Ordered updates, messaging |
| **Epoch-based** | Nested time epochs, binary search from current time | Sporadic/irregular updates |

Our adapter uses **sequential indexing** via bee-js's auto-detection (`feedIndexNext` header).

### Feed write optimization

- `makeFeedWriter().uploadPayload(stamp, data)` — for data <= 4096 bytes, writes directly into the SOC
- `makeFeedWriter().uploadReference(stamp, reference)` — writes a 32-byte reference to a `/bytes` upload. This is the **manifest-as-reference** pattern we use.
- Always fetch `feedIndexNext` from the response to know the next write index
- Our **per-topic write lock** (`feedWriteLocks`) prevents concurrent writes to the same feed — this is correct and necessary since each index is write-once

### Feed read

- `makeFeedReader().downloadPayload()` — reads the latest feed update
- `makeFeedReader().downloadReference()` — reads just the reference (if data was uploaded via `uploadReference`)
- Feed lookup: bee-js starts at the latest known index and works backward

### What our adapter does

We use the **manifest-as-reference** pattern for all manifests:
1. Serialize manifest JSON
2. Encrypt with AES-256-GCM
3. Upload to `/bytes` → get 64-char content hash
4. Write ONLY the hash to the feed (72-byte SOC)

Reading reverses this: read feed → get hash → download from `/bytes` → decrypt → parse.

### Optimization opportunities

1. **Advance retrieve requests**: For real-time collaboration, sequential feeds support **predictive lookups** — you can request the NEXT feed index before it exists, and the node holds the request open until the update arrives. This gives sub-second latency without polling. Not yet exposed in bee-js API but available at the protocol level.

2. **Feed manifests**: `POST /feeds/{owner}/{topic}` creates a Swarm manifest that auto-resolves through `/bzz`. This could enable ENS-like URLs for user data without blockchain interaction per update.

---

## 3. Postage Stamps

Stamps are the **payment mechanism** for Swarm storage. Every chunk needs a valid stamp.

### How they work

- Created via `POST /stamps/{amount}/{depth}`
- `depth`: log2 of storage slots. Min 17. Number of chunks = 2^depth
- `amount`: PLUR per chunk per block (the per-chunk balance)
- Total cost = 2^depth * amount (in PLUR). 1 xBZZ = 10^16 PLUR
- Gnosis Chain block time: 5 seconds

### Bucket mechanics

- Each batch has **65,536 buckets** (2^16, bucket depth fixed at 16)
- Each bucket holds 2^(depth - 16) slots
- Chunks assigned to buckets by first 16 bits of chunk address
- **Immutable batches**: batch is "full" when ANY single bucket fills up (due to random distribution, ~62-87% effective utilization depending on depth)
- **Mutable batches**: never fully exhausted — when a bucket overflows, oldest chunk in that bucket is replaced. Ideal for feeds.

### Effective utilization (at 99.9% confidence)

| Depth | Effective capacity | Utilization rate |
|------:|-------------------:|-----------------:|
| 20 | ~680 MB | ~62.89% |
| 22 | ~7.7 GB | ~65.05% |
| 24 | ~43 GB | ~68.48% |
| 28 | ~909 GB | ~87%+ |

### Lifecycle

- **Top-up**: `PATCH /stamps/topup/{batch_id}/{amount}` — adds balance to extend TTL
- **Dilute**: `PATCH /stamps/dilute/{batch_id}/{depth}` — increases depth (doubles capacity, halves TTL)
- Balances are **not revocable** — once deposited, funds are committed

**bee-js:** `bee.createPostageBatch()`, `bee.getPostageBatch()`, `bee.topUpBatch()`, `bee.diluteBatch()`, `bee.getPostageBatchBuckets()`

### What our adapter does

We fetch stamp status via `StampManager.getStampStatus()`, which reads `bee.getPostageBatch()` and computes health/utilization. We also offer top-up, expand, create, and cost estimation in the Settings UI.

### Optimization opportunity

Use **mutable stamps** for feed writes (our manifests). Immutable stamps waste bucket slots on each feed update, while mutable stamps reuse the same slot. The `bee.createPostageBatch(amount, depth, { immutableFlag: false })` option controls this.

---

## 4. Encryption

### Swarm-native encryption

- Enabled with `Swarm-Encrypt: true` header
- Symmetric counter-mode block cipher at chunk level
- Plaintext padded with random bytes to full 4KB before encryption
- Reference becomes 64 bytes (32 address + 32 decryption key) instead of 32 bytes
- Encrypted chunks are indistinguishable from random data in the network

### ACT (Access Control Trie)

- Selective multi-party access without exposing the decryption key broadly
- Uses **Diffie-Hellman key derivation** per grantee
- Publisher derives a unique lookup key + access key for each grantee using their public key
- The ACT is a Swarm manifest storing encrypted access keys
- **Timestamped history**: grantees can access the version they were granted
- Grant/revoke via `POST /grantee`, `PATCH /grantee/{address}`
- All ACT metadata is encrypted (even the grantee list)

**bee-js:** `bee.createGrantees()`, `bee.getGrantees()`, `bee.patchGrantees()`

### Our approach: app-layer AES-256-GCM

We encrypt at the application layer before upload:
```
Wallet personal_sign → keccak256 → secp256k1 private key → SHA-256 → AES-256 key
Format: [SWE prefix (3 bytes)] [IV (12 bytes)] [ciphertext + GCM auth tag]
```

**Advantages over Swarm-native:**
- Full control over key management
- Reference stays 32 bytes (no embedded key)
- Compatible with any storage backend
- Deterministic: same wallet = same key on any device

**For sharing**, we use `SHA-256(sender_address:recipient_address)` — both parties derive the same key independently.

### Future: ACT-based sharing

ACT is more secure than our current shared-key approach (which is derivable by anyone knowing both addresses). ACT provides proper per-grantee key derivation and revocation. This is on the roadmap.

---

## 5. PSS (Postal Service on Swarm)

PSS enables **anonymous, asynchronous messaging** between nodes.

### How it works

1. Sender creates a **Trojan chunk** — a CAC whose address is mined to fall in the recipient's neighborhood
2. Message is asymmetrically encrypted with recipient's public key
3. Chunk is push-synced to the target neighborhood via normal protocol
4. Recipient's node attempts to decrypt all arriving chunks, checking for topic match
5. For third parties: indistinguishable from regular encrypted chunk traffic

### Trojan chunk structure

```
[8-byte span] [32-byte mined nonce] [4064-byte encrypted payload]
  Payload: [2-byte msg length] [32-byte obfuscated topic] [message] [random padding]
```

### Latency

- Mining difficulty proportional to target prefix length (log of network size)
- Expected: a few seconds for nonce mining + normal forwarding time
- If recipient is offline, the Trojan chunk persists (controlled by stamp TTL) — **asynchronous delivery**

### API

```
POST /pss/send/{topic}/{targets}?recipient={publicKey}  — send a message
WS   /pss/subscribe/{topic}                              — subscribe via WebSocket
```

**bee-js:** `bee.pssSend(stamp, topic, target, data, recipient?)`, `bee.pssSubscribe(topic, handler)`, `bee.pssReceive(topic, timeout?)`

### What we could build

1. **Real-time sync notifications**: When a user uploads new ops, send a PSS message to collaborators. They poll the feed only when notified — no wasted polling.
2. **Chat interface**: PSS provides the transport for encrypted 1-to-1 messaging. Combined with outbox feeds for message history.
3. **Initial key exchange**: Use PSS for the first contact (X3DH handshake), then switch to feeds for ongoing communication.

---

## 6. GSOC (Graffiti SOC)

GSOC is a **many-to-one notification system** — multiple writers can send updates to a single receiving node.

### How it works

- A private key is mined so that its SOC address falls within the target node's neighborhood
- Any node with access to the mined private key can write SOC updates
- The target node subscribes via WebSocket and receives updates in real-time
- Think of it as a "mailbox" that anyone with the key can drop messages into

### Differences from regular feeds

| | Feeds | GSOC |
|-|-------|------|
| Writers | Single (owner) | Multiple (anyone with the key) |
| Readers | Anyone | Single target node |
| Direction | One-to-many broadcast | Many-to-one collection |

### API

```
WS /gsoc/subscribe/{address}  — subscribe to incoming GSOC messages
```

**bee-js:** `bee.gsocMine(targetOverlay, identifier, proximity?)`, `bee.gsocSend(stamp, signer, identifier, data)`, `bee.gsocSubscribe(address, identifier, handler)`

### Requirements

- **Only full nodes** can receive GSOC updates (light nodes don't sync neighborhood chunks)
- **Must use mutable stamps** to avoid bucket exhaustion

### What we could build

1. **Collaboration coordination**: When adding a collaborator, GSOC provides the "subscribe to updates" mechanism. The coordinator node receives notifications from all collaborators via GSOC, then updates a shared feed.
2. **Service registration**: Multiple Connect instances register with a switchboard via GSOC.

---

## 7. WebSocket API

The Bee node supports WebSocket connections for real-time features:

| Endpoint | Purpose | bee-js method |
|----------|---------|---------------|
| `WS /pss/subscribe/{topic}` | Stream decrypted PSS messages | `bee.pssSubscribe()` |
| `WS /gsoc/subscribe/{address}` | Stream GSOC updates | `bee.gsocSubscribe()` |
| `WS /chunks/stream` | Stream chunk uploads (parallel) | N/A (raw WS) |

**Feed updates do NOT have a native WebSocket subscription.** Options for real-time feed watching:

1. **Poll** `GET /feeds/{owner}/{topic}` at intervals (what we do now)
2. **Combine with GSOC**: publisher sends GSOC notification on update, subscriber only polls on notification
3. **Combine with PSS**: publisher sends PSS notification on update
4. **Advance retrieve requests** (protocol-level, not API-exposed): request next feed index before it exists; the node holds the request open until the update arrives

---

## 8. File Upload / Swarm Manifests

Swarm has its own manifest system (separate from our custom document manifests).

### Mantaray manifests

- Compacted Merkle tries — each node: path segment + target reference + metadata
- Used for file collections (directories/websites)
- Upload: `POST /bzz` with `Swarm-Collection: true` header + TAR body
- Download: `GET /bzz/{manifest-hash}/{path}` — resolves path through the trie
- Supports `indexDocument` (default page) and `errorDocument` (404 page)

### What we could build

1. **File attachments**: Upload files (images, PDFs) directly to Swarm via `/bzz`, get a manifest reference, store that reference inside document model operations. Files become content-addressed and encrypted.
2. **Document export**: Package an entire drive as a Swarm collection (HTML + JSON), upload as a website manifest, share via a single Swarm hash or ENS name.
3. **Static publishing**: Deploy the Connect SPA itself to Swarm (`HashRouter` + ENS domain = fully decentralized app).

**bee-js:** `bee.uploadFile()`, `bee.downloadFile()`, `bee.uploadFiles()`, `bee.uploadCollection()`

---

## 9. Performance Optimization

### Current bottlenecks in our adapter

1. **Sequential feed writes**: each manifest update is a serial write (upload /bytes + write SOC). With 3 manifest levels (doc + drive + user), a single edit triggers 3 sequential feed writes.
2. **Polling for updates**: no real-time notification when remote data changes.
3. **No parallelism on recovery**: documents are hydrated one at a time.

### Optimization opportunities

| Optimization | How | Impact |
|-------------|-----|--------|
| **Parallel recovery** | Download all operation batches concurrently (Promise.all) instead of sequentially | 5-10x faster hydration for users with many documents |
| **Mutable stamps for feeds** | Use `immutableFlag: false` when creating stamps used for manifest feeds | Prevents bucket exhaustion on frequent updates |
| **Chunk stream upload** | Use `WS /chunks/stream` for bulk uploads during share/export | Higher throughput for large data transfers |
| **GSOC notifications** | Publisher sends GSOC notification on manifest update; collaborators poll only on notification | Eliminates polling, sub-second sync latency |
| **Batch stamp bucket monitoring** | Use `GET /stamps/{batch_id}/buckets` to monitor utilization hotspots | Prevent stamp exhaustion before it happens |
| **Erasure coding** | Enable Reed-Solomon coding for critical data (manifests) | Higher availability, survives node outages |
| **Tags for upload progress** | Use `POST /tags` to track upload completion | Show progress UI for large uploads |

### Feed write throughput

- Bee processes feed writes sequentially per topic (SOC index is monotonic)
- Our 3-second debounce already batches rapid edits into single writes
- The per-topic write lock prevents SOC index conflicts
- For multi-document bursts: our throttled flush (max 5 concurrent) prevents overloading the node
- **Key insight**: the bottleneck is not upload speed but feed propagation time (SOC must be stored by the neighborhood before the next write is visible)

---

## 10. Neighborhoods and Topology

### Data distribution

- Kademlia topology: each node has a 256-bit overlay address
- **Proximity Order (PO)**: number of leading bits two addresses share
- Chunks stored by nodes with highest PO to the chunk address
- Push-sync moves chunks from uploader to the responsible neighborhood
- Pull-sync replicates chunks within a neighborhood (at least 4 copies)

### Redundancy

- **Local**: all nodes in a neighborhood store the same chunks (4+ copies)
- **Cross-neighborhood**: erasure coding distributes parity chunks across neighborhoods
- **Recovery**: if a chunk becomes unavailable, a PSS-based recovery protocol contacts a known pinner who re-uploads it

### What happens when our Bee node goes offline

- Data uploaded to Swarm is stored by the neighborhood, not just our node
- Other nodes in the neighborhood serve our data while we're offline
- When we come back: pull-sync catches up on any chunks we missed
- **Stamps must still be valid** — expired stamps = chunks evicted from reserves into cache, then LRU-evicted

---

## 11. Features We Can Implement

### Immediate (using existing Bee APIs)

| Feature | How | Complexity |
|---------|-----|:----------:|
| **File attachments** | `bee.uploadFile()` with encryption, store reference in document ops | Low |
| **Real-time sync via GSOC** | Mine GSOC key for collaborator's overlay, send notification on manifest update | Medium |
| **Chat via PSS** | `bee.pssSend()` for messages, `bee.pssSubscribe()` for receiving, feeds for history | Medium |
| **Upload progress** | `POST /tags` to create tracking tag, poll `GET /tags/{id}` for completion | Low |
| **Stamp health alerts** | `GET /stamps/{id}/buckets` to detect hot buckets before exhaustion | Low |
| **Content availability check** | `GET /stewardship/{address}` to verify data is still retrievable | Low |

### Medium-term (requires SwarmChannel for DocSync)

| Feature | How | Complexity |
|---------|-----|:----------:|
| **Live collaborative editing** | SwarmChannel implementing IChannel (inbox/outbox/deadLetter), polling or GSOC-triggered | High |
| **Conflict resolution** | Handled by reactor's SyncManager — we just provide the transport | Already built |
| **Multi-author feeds** | Each collaborator writes to their own op feed, coordinator merges via index feed | Medium |

### Long-term (infrastructure)

| Feature | How | Complexity |
|---------|-----|:----------:|
| **Fully decentralized Connect** | Deploy SPA to Swarm (`HashRouter` + ENS), all data on Swarm | Medium |
| **On-chain identity registry** | ETH address → Swarm signer address mapping on Gnosis Chain | Medium |
| **ACT-based sharing** | Replace SHA-256 shared key with proper ACT access control | Medium |

---

## 12. Bee HTTP API Quick Reference

### Data

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/bytes` | POST | Upload raw data |
| `/bytes/{ref}` | GET | Download raw data |
| `/bzz` | POST | Upload file/collection (with manifest) |
| `/bzz/{addr}/{path}` | GET | Download file from manifest |
| `/chunks` | POST | Upload raw chunk |
| `/chunks/{addr}` | GET | Download raw chunk |
| `/chunks/stream` | WS | Stream chunk uploads |

### Feeds

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/feeds/{owner}/{topic}` | GET | Read latest feed update |
| `/feeds/{owner}/{topic}` | POST | Create feed manifest |
| `/soc/{owner}/{id}` | POST | Upload SOC directly |
| `/soc/{owner}/{id}` | GET | Download SOC directly |

### Messaging

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/pss/send/{topic}/{targets}` | POST | Send PSS message |
| `/pss/subscribe/{topic}` | WS | Subscribe to PSS messages |
| `/gsoc/subscribe/{addr}` | WS | Subscribe to GSOC updates |

### Stamps

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/stamps` | GET | List own batches |
| `/stamps/{id}` | GET | Get batch details |
| `/stamps/{id}/buckets` | GET | Get bucket utilization |
| `/stamps/{amount}/{depth}` | POST | Create batch |
| `/stamps/topup/{id}/{amount}` | PATCH | Extend TTL |
| `/stamps/dilute/{id}/{depth}` | PATCH | Increase capacity |

### Access Control

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/grantee` | POST | Create grantee list |
| `/grantee/{addr}` | GET | Get grantee list |
| `/grantee/{addr}` | PATCH | Add/revoke grantees |

### Node Info

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Node health |
| `/readiness` | GET | Node ready state |
| `/addresses` | GET | Node addresses (overlay, public key, ethereum) |
| `/wallet` | GET | Node wallet balances |
| `/topology` | GET | Network topology |
| `/chainstate` | GET | Current chain state (price, block) |
| `/reservestate` | GET | Reserve state (radius, commitment) |
| `/stewardship/{addr}` | GET | Check content retrievability |
| `/stewardship/{addr}` | PUT | Re-upload content |
| `/pins` | GET | List pinned refs |
| `/pins/{ref}` | POST/DELETE | Pin/unpin content |
| `/tags` | POST | Create upload tag |
| `/tags/{id}` | GET | Get upload progress |

---

## 13. Key bee-js Methods We Use vs Available

### Currently using

| Method | Where | Purpose |
|--------|-------|---------|
| `new Bee(url, { signer })` | `swarm-client.ts` | Create client |
| `bee.uploadData(stamp, data)` | `swarm-client.ts` | Upload encrypted ops/manifests |
| `bee.downloadData(ref)` | `swarm-client.ts` | Download + decrypt |
| `bee.makeFeedReader(topic, owner)` | `swarm-client.ts` | Read feeds |
| `bee.makeFeedWriter(topic)` | `swarm-client.ts` | Write feeds |
| `bee.getHealth()` | `swarm-client.ts` | Health check |
| `bee.getPostageBatch(id)` | `stamp-manager.ts` | Stamp status |
| `bee.topUpBatch(id, amount)` | `stamp-manager.ts` | Extend stamp |
| `bee.diluteBatch(id, depth)` | `stamp-manager.ts` | Expand stamp |
| `bee.getChainState()` | `stamp-manager.ts` | Storage price |
| `bee.createGrantees(stamp, keys)` | `swarm-client.ts` | ACT create |
| `bee.patchGrantees(stamp, ref, hist, ops)` | `swarm-client.ts` | ACT grant/revoke |
| `bee.getGrantees(ref)` | `swarm-client.ts` | ACT read |

### Available but NOT yet used

| Method | What it does | Use case |
|--------|-------------|----------|
| `bee.uploadFile(stamp, data, name)` | Upload file with manifest | File attachments in documents |
| `bee.downloadFile(ref)` | Download file from manifest | Retrieve attachments |
| `bee.uploadCollection(stamp, files)` | Upload directory | Export drive as website |
| `bee.pssSend(stamp, topic, target, data, recipient)` | Send PSS message | Real-time notifications, chat |
| `bee.pssSubscribe(topic, handler)` | WebSocket PSS subscription | Receive messages |
| `bee.pssReceive(topic, timeout)` | Await single PSS message | One-shot message receive |
| `bee.gsocMine(overlay, id, proximity)` | Mine GSOC key for target | Target a specific node |
| `bee.gsocSend(stamp, signer, id, data)` | Send GSOC update | Notification to coordinator |
| `bee.gsocSubscribe(addr, id, handler)` | WebSocket GSOC subscription | Receive notifications |
| `bee.getPostageBatchBuckets(id)` | Bucket utilization details | Stamp health monitoring |
| `bee.createPostageBatch(amount, depth, { immutableFlag: false })` | Create mutable stamp | Better for feeds |
| `bee.isReferenceRetrievable(ref)` | Check if content exists | Availability verification |
| `bee.reuploadPinnedData(ref)` | Re-upload to network | Data recovery |
| `FeedWriter.uploadReference(stamp, ref)` | Write just the reference | More efficient than uploadPayload for our manifest-as-reference pattern |

---

## 14. Bee v2.7.x Release Notes (Our Node Version)

Our Bee node runs **v2.7.1**. Key changes relevant to the adapter:

### v2.7.0 — Feature release

| Change | Impact on our adapter |
|--------|----------------------|
| **Feed auto-racing**: both legacy and wrapped feed versions now race automatically. `Swarm-Feed-Resolved-Version` response header shows which resolved. | We no longer need to worry about feed version selection. The `swarm-feed-legacy-resolve` query param was removed — if we ever used it, it would break. Our adapter never did, so we're fine. |
| **AutoTLS/WSS**: Secure WebSocket connections via `p2p-wss-enable` flag. | Relevant when we implement PSS/GSOC WebSocket subscriptions — TLS ensures encrypted transport for real-time messaging. |
| **Redundancy validation**: `/bytes` and `/bzz` handlers now validate the redundancy level header. | If we ever set `Swarm-Redundancy-Level`, it must be a valid value or the request is rejected. Currently we don't set it. |
| **`POST /tags` no longer requires a body** | Simplifies upload progress tracking when we implement it. |
| **`/reservestate` now returns `reserveCapacityDoubling`** | Useful for monitoring how close the network reserve is to doubling. |
| **Multiple underlay addresses per node** | No direct impact — improves P2P connectivity for our Bee node. |

### v2.7.1 — Stability patch

Focuses on P2P networking fixes for WSS adoption at scale. No API changes that affect our adapter. Key fixes:

- **Fresh connection timeout per underlay address** — prevents timeout starvation when peers have multiple addresses
- **Transport-aware address selection** — nodes only connect via locally enabled transports
- **Exponential backoff for reacher** — reduces unnecessary P2P ping traffic
- **`TopUpBatch` nil pointer panic fix** — critical for our stamp management (prevents crash when topping up stamps on light nodes)
- **Optimized postage batch snapshot loading** — faster node startup with large batch histories

### Node operator note

Some hosting providers flag Bee's libp2p networking as a scanning attack (connecting to private IP ranges). If the Bee node gets throttled, iptables rules can drop outbound traffic to private ranges:
```bash
iptables -I OUTPUT 1 -d 172.16.0.0/12 -j DROP
iptables -I OUTPUT 1 -d 192.168.0.0/16 -j DROP
iptables -I OUTPUT 1 -d 10.0.0.0/8 -j DROP
```
