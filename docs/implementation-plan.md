# Bee Reactor Adapter - Implementation Plan

## Progress & What's Next

### Done

- [x] Phase 1: `withOperationStore()` / `withKeyframeStore()` added to `ReactorBuilder`
- [x] Phase 2: `SwarmClient` wrapper (bytes mode + feed mode, auto-detect)
- [x] Phase 3: `SwarmOperationStore` (write-through IOperationStore)
- [x] Phase 4: `SwarmKeyframeStore` (write-through IKeyframeStore with manifest compaction)
- [x] Phase 5: `SwarmHydrator` (startup sync + polling)
- [x] Phase 6: `BeeReactorAdapter` orchestrator, types, index.ts
- [x] `SwarmSyncReadModel` — IReadModel that uploads ops to Swarm (production integration path)
- [x] E2E integration tests (12/12 passing against `bee dev`)
- [x] Published 3 npm packages (`@liberuum-org/reactor`, `bee-reactor-adapter`, `switchboard`)
- [x] Clean install via `resolutions` in package.json — no manual patching
- [x] Verified with full Vetra stack (Connect + Switchboard + switchboard-cli + bee dev)
- [x] Verified Renown signer data (user Ethereum address) present in all Swarm-stored operations

### Recently Completed

- [x] User manifest on Swarm — `SwarmSyncReadModel` extracts `signer.user.address` from Renown-signed ops, creates per-user manifest keyed by Ethereum address
- [x] Stamp status API — `SwarmClient.getStampStatus()` returns TTL, capacity, health
- [x] `SwarmConnectPlugin` created — browser-side plugin subscribing to `window.ph.renown` events
- [x] Switchboard fork updated to `swarm.4` — depends on adapter 0.3.0 (fixes nested dep issue)
- [x] Adapter `0.3.0` published with 16 tests

### Next

- [x] **SwarmConnectPlugin browser test** -- wallet signature, IndexedDB cache, auto-reconnect on reload
- [x] **ACT access control API** -- `uploadData({act:true})`, `grantAccess()`, `revokeAccess()`, `createGrantees()`, `getGrantees()`
- [x] **App-layer AES-256-GCM encryption** -- operations encrypted before Swarm upload, decryptable with same key
- [x] **Clean-state recovery** -- encrypted docs on Swarm survive any restart, same key always works
- [x] **Published 0.7.0** -- 30 tests, eth_requestAccounts fix, cache logging
- [x] **Connect Swarm settings UI** -- stamp status, document tree, drive names, clear/reconnect (published swarm.5)
- [x] **Swarm drive loading** -- hydrate documents from user manifest into reactor on login, correct drive names
- [x] **Feed mode testing** -- tested with real Bee node, SOC feeds working, per-topic write lock
- [x] **Concurrent upload safety** -- per-topic write lock in adapter + debounced manifest writes in plugin
- [x] **Feed optimization (v0.15.0)** -- debounced doc manifest writes (3s), op batch accumulation, manifest-as-reference (72-byte SOC), manifest compaction
- [x] **Settings loading state** -- spinner during init, error message when disconnected with setup instructions
- [x] **Clean manifest after recovery** -- prevents stale drive accumulation across recovery cycles
- [x] **Postage stamp management** -- settings UI has top-up, expand, create stamp, fund wallet buttons
- [x] **Per-doc sync status indicator** -- sync badges (buffered/flushing/synced/error) per document in settings UI
- [x] **Multi-drive sync + recovery** -- correct drive→doc mapping via lastSeenDriveId, multi-drive recovery with per-drive grouping
- [x] **Stamp management UX** -- extend duration, expand storage, create stamp dropdowns with human-readable presets (matching beeport)
- [x] **Correct storage stats** -- uses bee-js batch.usage/size/remainingSize, depth/bucketDepth exposed
- [x] **Published adapter 0.16.0 + Connect swarm.11** -- all fixes included
- [ ] **Encrypted sharing** -- re-encrypt document key for recipient's public key
- [ ] **Settings UI design polish** -- match Connect aesthetic, improve stamp management UX
- [ ] **Mode 2: Swarm Only** -- Connect without Switchboard, sync via Swarm feed polling
- [ ] **Mode 3: Full Swarm** -- Connect SPA deployed to Swarm, HashRouter, ENS, package registry on Swarm

## Context

The Powerhouse Reactor stores documents as event-sourced operations + keyframes. Currently only Kysely/SQL backends exist (PGlite in browser, PostgreSQL on server). The planning docs at `reactor/docs/archive/planning-v1/Storage/IOperationStore.md` explicitly list `SwarmOperationStore` as a planned implementation alongside `IPFSOperationStore` and `FilesystemOperationStore`.

The architecture docs say "Provide via ReactorBuilder" but `withOperationStore()`/`withKeyframeStore()` builder methods were **never implemented** — only `withKysely()` exists. This is the gap we need to bridge.

**Goal:** Run Connect app with reactor persisting ops/keyframes to Swarm Bee, while keeping the GraphQL query interface and local reactivity working.

## Approach: Swarm-Backed IOperationStore + IKeyframeStore

Two changes are needed:

### Change 1: Add builder injection points (small reactor change)
Add `withOperationStore()` and `withKeyframeStore()` to `ReactorBuilder` so it uses custom stores instead of always creating `KyselyOperationStore`/`KyselyKeyframeStore`. This fulfills the documented design intent.

### Change 2: Implement SwarmOperationStore + SwarmKeyframeStore
Create implementations of `IOperationStore` and `IKeyframeStore` that persist to Swarm Bee while using a local SQL cache for fast reads.

The stores use a **write-through** pattern:
- **Writes** go to both local SQL (for fast reads) AND Swarm `/bytes` (for persistence)
- **Reads** serve from local SQL cache
- **Startup** hydrates local SQL from Swarm feeds if the cache is empty/stale
- **Feed** per document acts as a mutable pointer to the latest operations manifest on Swarm

```
Write: action -> reducer -> SwarmOperationStore
                              ├─> local SQL cache (fast reads, projections)
                              └─> Swarm /bytes (permanent decentralized storage)
                                  └─> Feed update (mutable pointer)

Read:  SwarmOperationStore -> local SQL cache -> return ops

Startup: Swarm Feed -> download missing ops -> populate local SQL cache
```

## Implementation Phases

### Phase 1: ReactorBuilder Storage Injection -- DONE

**File:** `powerhouse/packages/reactor/src/core/reactor-builder.ts`

Add two optional fields and builder methods:

```typescript
private operationStoreInstance?: IOperationStore;
private keyframeStoreInstance?: IKeyframeStore;

withOperationStore(store: IOperationStore): this {
  this.operationStoreInstance = store;
  return this;
}

withKeyframeStore(store: IKeyframeStore): this {
  this.keyframeStoreInstance = store;
  return this;
}
```

In `buildModule()`, change lines 221-226 from hardcoded creation to:

```typescript
const operationStore = this.operationStoreInstance
  ?? new KyselyOperationStore(database as unknown as Kysely<StorageDatabase>);
const keyframeStore = this.keyframeStoreInstance
  ?? new KyselyKeyframeStore(database as unknown as Kysely<StorageDatabase>);
```

This is a backwards-compatible change — existing code that doesn't call `withOperationStore()` gets the same behavior as before.

### Phase 2: Swarm Client Wrapper -- DONE

**File:** `bee-reactor-adaptor/src/swarm-client.ts`

Thin wrapper around `@ethersphere/bee-js` Bee SDK:

```typescript
class SwarmClient {
  constructor(config: { beeUrl: string; batchId: string; signerPrivateKey: string })

  // Content-addressed immutable storage
  async uploadData(data: Uint8Array | string): Promise<string>  // returns reference
  async downloadData(reference: string): Promise<Uint8Array>

  // Per-document mutable feed
  async readManifest(documentId: string): Promise<SwarmDocumentManifest | null>
  async updateManifest(documentId: string, manifest: SwarmDocumentManifest): Promise<void>
}
```

Feed topic per document: `Topic.fromString("ph:doc:" + documentId)`

### Phase 3: SwarmOperationStore -- DONE

**File:** `bee-reactor-adaptor/src/swarm-operation-store.ts`

Implements `IOperationStore` (from `reactor/src/storage/interfaces.ts`):

```typescript
class SwarmOperationStore implements IOperationStore {
  constructor(
    private swarmClient: SwarmClient,
    private localStore: KyselyOperationStore,  // SQL cache for reads
  )

  async apply(documentId, documentType, scope, branch, revision, fn, signal?) {
    // 1. Write to local SQL first (fast, ACID)
    await this.localStore.apply(documentId, documentType, scope, branch, revision, fn, signal);

    // 2. Upload to Swarm asynchronously (fire-and-forget with retry queue)
    this.uploadToSwarm(documentId, scope, branch, revision).catch(err => {
      this.retryQueue.enqueue({ documentId, scope, branch, revision });
      this.logger.warn("Swarm upload failed, queued for retry", err);
    });
  }

  // All read methods delegate to local SQL cache
  async getSince(...args) { return this.localStore.getSince(...args); }
  async getSinceId(...args) { return this.localStore.getSinceId(...args); }
  async getConflicting(...args) { return this.localStore.getConflicting(...args); }
  async getRevisions(...args) { return this.localStore.getRevisions(...args); }

  private async uploadToSwarm(documentId, scope, branch, revision) {
    // Get the operations that were just written
    const ops = await this.localStore.getSince(documentId, scope, branch, revision - 1);
    // Serialize and upload to /bytes
    const reference = await this.swarmClient.uploadData(JSON.stringify(ops.results));
    // Update feed manifest
    const manifest = await this.swarmClient.readManifest(documentId) ?? createEmptyManifest(documentId);
    manifest.operationBatches.push({ reference, scope, branch, startIndex: revision, endIndex: revision + ops.results.length - 1, timestamp: new Date().toISOString() });
    manifest.latestRevision[scope] = revision + ops.results.length - 1;
    await this.swarmClient.updateManifest(documentId, manifest);
  }
}
```

### Phase 4: SwarmKeyframeStore -- DONE

**File:** `bee-reactor-adaptor/src/swarm-keyframe-store.ts`

Same write-through pattern:

```typescript
class SwarmKeyframeStore implements IKeyframeStore {
  constructor(
    private swarmClient: SwarmClient,
    private localStore: KyselyKeyframeStore,
  )

  async putKeyframe(documentId, scope, branch, revision, document, signal?) {
    await this.localStore.putKeyframe(documentId, scope, branch, revision, document, signal);
    // Upload keyframe to Swarm (async, with retry)
    const reference = await this.swarmClient.uploadData(JSON.stringify({ documentId, scope, branch, revision, document }));
    // Update manifest
    const manifest = await this.swarmClient.readManifest(documentId) ?? createEmptyManifest(documentId);
    manifest.keyframes.push({ reference, scope, branch, revision });
    await this.swarmClient.updateManifest(documentId, manifest);
  }

  // Read methods delegate to local cache
  async findNearestKeyframe(...args) { return this.localStore.findNearestKeyframe(...args); }
  async listKeyframes(...args) { return this.localStore.listKeyframes(...args); }
  async deleteKeyframes(...args) { return this.localStore.deleteKeyframes(...args); }
}
```

### Phase 5: Swarm Hydrator (Startup Sync) -- DONE

**File:** `bee-reactor-adaptor/src/swarm-hydrator.ts`

On startup, compares local SQL state with Swarm and downloads missing data:

```typescript
class SwarmHydrator {
  async hydrate(documentIds: string[], localStore: KyselyOperationStore, localKeyframeStore: KyselyKeyframeStore) {
    for (const docId of documentIds) {
      const manifest = await this.swarmClient.readManifest(docId);
      if (!manifest) continue;

      const localRevisions = await localStore.getRevisions(docId, "main");

      for (const batch of manifest.operationBatches) {
        const localRev = localRevisions.revision[batch.scope] ?? -1;
        if (batch.endIndex > localRev) {
          const data = await this.swarmClient.downloadData(batch.reference);
          const ops = JSON.parse(new TextDecoder().decode(data));
          // Insert into local SQL (via reactor.load or direct store insert)
        }
      }

      // Download missing keyframes similarly
    }
  }

  startPolling(intervalMs: number) { /* periodic feed check */ }
}
```

### Phase 6: Main Adapter + Connect Integration -- PARTIAL (adapter done, Connect wiring not yet)

**File:** `bee-reactor-adaptor/src/bee-reactor-adapter.ts`

```typescript
class BeeReactorAdapter {
  constructor(config: BeeAdapterConfig)

  // Returns stores for ReactorBuilder
  getOperationStore(kyselyDb: Kysely<Database>): SwarmOperationStore
  getKeyframeStore(kyselyDb: Kysely<Database>): SwarmKeyframeStore

  // Start hydration after reactor is built
  async start(module: ReactorModule): Promise<void>
  async stop(): Promise<void>
}
```

**Usage in Connect:**

```typescript
const beeAdapter = new BeeReactorAdapter({
  beeUrl: 'http://100.121.241.25:1633/',
  batchId: process.env.SWARM_STAMP_ID,
  signerPrivateKey: process.env.SWARM_SIGNER_KEY,
});

const kyselyDb = new Kysely<Database>({ dialect: new PGliteDialect(pg) });

const builder = new ReactorBuilder()
  .withDocumentModels(models)
  .withKysely(kyselyDb)
  .withOperationStore(beeAdapter.getOperationStore(kyselyDb))   // NEW
  .withKeyframeStore(beeAdapter.getKeyframeStore(kyselyDb))     // NEW
  .withChannelScheme(ChannelScheme.CONNECT);

const module = await builder.buildModule();
await beeAdapter.start(module);  // hydrate from Swarm
```

**Usage in Switchboard:** Same pattern, just different Kysely dialect (PostgreSQL instead of PGlite).

## How the User Interacts via Connect

### What Changes in Connect Code?

**Only one file changes:** `apps/connect/src/utils/reactor.ts` — the `createBrowserReactor()` function. The rest of the Connect app (UI, document editors, drive navigation, subscriptions, processors) is **completely unchanged**. The Swarm adapter is invisible to the UI layer.

**Before (current):**

```typescript
// apps/connect/src/utils/reactor.ts
const pg = new PGlite("idb://reactor", { relaxedDurability: true });
const builder = new ReactorBuilder()
  .withDocumentModels(documentModelModules)
  .withKysely(new Kysely<Database>({ dialect: new PGliteDialect(pg) }))
  .withChannelScheme(ChannelScheme.CONNECT);
```

**After (with Swarm):**

```typescript
// apps/connect/src/utils/reactor.ts
const pg = new PGlite("idb://reactor", { relaxedDurability: true });
const kyselyDb = new Kysely<Database>({ dialect: new PGliteDialect(pg) });

const beeAdapter = new BeeReactorAdapter({
  beeUrl: import.meta.env.SWARM_BEE_URL ?? 'http://localhost:1633',
  batchId: import.meta.env.SWARM_STAMP_ID,
  signerPrivateKey: import.meta.env.SWARM_SIGNER_KEY,
});

const builder = new ReactorBuilder()
  .withDocumentModels(documentModelModules)
  .withKysely(kyselyDb)
  .withOperationStore(beeAdapter.getOperationStore(kyselyDb))  // NEW
  .withKeyframeStore(beeAdapter.getKeyframeStore(kyselyDb))    // NEW
  .withChannelScheme(ChannelScheme.CONNECT);

const module = await builder.buildModule();
await beeAdapter.start(module);  // hydrate from Swarm on startup
```

The store file `apps/connect/src/store/reactor.ts` (which calls `createBrowserReactor`) does NOT change at all — it just calls the factory function.

### User Experience (unchanged)

The user interacts with Connect exactly the same way:

1. **Open app** -> reactor starts, Swarm hydrator downloads any ops from Swarm feeds into local PGlite
2. **Browse drives** -> served from local PGlite (fast, same as before)
3. **Open document** -> `reactor.get(docId)` reads from DocumentView (local SQL projection)
4. **Edit document** -> `reactor.execute(docId, actions)` writes ops to local SQL AND uploads to Swarm `/bytes` in background
5. **Navigate, search, query** -> all served from local SQL projections (GraphQL API unchanged)
6. **Close app** -> data is safe on Swarm; next time the app opens, it hydrates from Swarm

### What About DocSync / Switchboard?

DocSync (syncing to Switchboard via GraphQL) can still work alongside Swarm storage. They are orthogonal:
- **DocSync**: syncs ops between reactor instances via GraphQL channels
- **Swarm adapter**: persists ops to decentralized storage

Both happen on `JOB_WRITE_READY`. A user could run Connect with:
- Swarm only (no Switchboard) — fully decentralized
- Swarm + Switchboard — decentralized persistence + centralized query/sync
- Switchboard only (current behavior) — no change

### Environment Variables (new)

```env
SWARM_BEE_URL=http://localhost:1633    # Bee node URL (dev: bee dev, prod: DappNode)
SWARM_STAMP_ID=abc123...               # Postage stamp batch ID
SWARM_SIGNER_KEY=0x...                 # Private key for feed signing
```

These could also be configured via a settings UI in Connect (future enhancement).

## Three Deployment Modes

### Mode 1: Swarm Storage + Switchboard (Hybrid)

The simplest upgrade — add Swarm persistence while keeping Switchboard for sync and GraphQL.

```
Browser (Connect)                 Server (Switchboard)
  ├─ PGlite (local cache)          ├─ PostgreSQL
  ├─ Swarm adapter (persistence)   ├─ GraphQL API
  └─ DocSync → Switchboard         └─ DocSync channels
         ↕                                ↕
    Swarm Bee Node                   (optional Swarm)
```

- Connect writes ops to local PGlite + Swarm
- DocSync still pushes/pulls ops to Switchboard via GraphQL
- Switchboard provides the GraphQL query interface
- If Switchboard goes down, data is safe on Swarm
- **Use case**: Teams that want decentralized backup + centralized collaboration

### Mode 2: Swarm Only (Fully Decentralized)

No Switchboard at all. Connect runs as a pure P2P client.

```
Browser (Connect)
  ├─ PGlite (local cache)
  ├─ Swarm adapter (persistence)
  ├─ Swarm hydrator (poll feeds for updates)
  └─ NO DocSync / NO Switchboard
         ↕
    Swarm Bee Node
```

- Connect writes ops to local PGlite + Swarm
- No `ChannelScheme.CONNECT` — skip DocSync entirely
- Multiple Connect instances sync via Swarm feeds (poll for updates)
- GraphQL query interface still works locally (reactor-api can run in-browser or you query the reactor directly)
- **Use case**: Sovereign data, no servers, P2P collaboration

**Connect code change** (in `createBrowserReactor`):

```typescript
const builder = new ReactorBuilder()
  .withDocumentModels(models)
  .withKysely(kyselyDb)
  .withOperationStore(beeAdapter.getOperationStore(kyselyDb))
  .withKeyframeStore(beeAdapter.getKeyframeStore(kyselyDb));
  // NO .withChannelScheme() — no DocSync at all
```

### Mode 3: Fully on Swarm (App + Storage)

Connect itself deployed as a static website on Swarm, accessed via ENS. The app talks to a Bee node for both serving the UI and storing documents.

```
User Browser
  ↓ loads app from Swarm
  ↓ https://yourapp.eth.limo/  (or bzz://feed-manifest-hash)
  ↓
Connect SPA (served from Swarm)
  ├─ PGlite (in-browser IndexedDB)
  ├─ Swarm adapter → Bee Node API
  └─ Hash-based routing (/#/drive/doc)
         ↕
    Bee Node (localhost:1633 or gateway)
```

**Deployment steps:**

1. **Build Connect for Swarm**:

```bash
cd apps/connect
# Build with Swarm-specific env vars
SWARM_BEE_URL=http://localhost:1633 pnpm run build
```

2. **Switch to hash-based routing** (Swarm has no server-side rewrites):

```typescript
// In Connect's router config, use HashRouter instead of BrowserRouter
import { HashRouter } from 'react-router-dom';
// Routes: /#/d/my-drive  /#/d/my-drive/my-doc
```

3. **Upload to Swarm via feed** (so you can update without changing ENS):

```bash
# Create publisher identity (one-time)
swarm-cli identity create connect-publisher

# Deploy to Swarm feed
swarm-cli feed upload ./dist \
  --identity connect-publisher \
  --topic-string connect-app \
  --stamp $SWARM_STAMP_ID \
  --index-document index.html \
  --error-document index.html

# Returns feed manifest hash (stable URL!)
# e.g. bzz://6c30ef2254ac15658959cb...
```

4. **Register ENS** (one-time):

```
Set content hash on yourapp.eth to:
bzz://6c30ef2254ac15658959cb...  (feed manifest hash)
```

5. **Access**:

```
https://yourapp.eth.limo/          (via eth.limo gateway)
https://yourapp.bzz.link/          (via bzz.link gateway)
http://localhost:1633/bzz/yourapp.eth/  (local node)
```

6. **Update** (redeploy):

```bash
# Same command, new build output
pnpm run build
swarm-cli feed upload ./dist \
  --identity connect-publisher \
  --topic-string connect-app \
  --stamp $SWARM_STAMP_ID \
  --index-document index.html \
  --error-document index.html
# ENS stays the same — feed updates automatically
```

**CORS consideration**: When Connect is served from Swarm (e.g. `yourapp.eth.limo`), it needs to talk to a Bee node API. Options:
- **Local Bee node**: User runs `bee dev` or full node on localhost:1633 (no CORS issues)
- **Same gateway**: If the gateway exposes both website and API (configure `cors-allowed-origins`)
- **DappNode**: User's own DappNode Bee at their Tailscale address

**Connect code changes for Mode 3**:
- Switch router to `HashRouter` (for Swarm compatibility)
- Make Bee URL configurable (env var or settings UI)
- Remove hard dependency on Switchboard/Vercel rewrites

### Comparison Table

| Feature | Mode 1 (Hybrid) | Mode 2 (Swarm Only) | Mode 3 (Full Swarm) |
| --- | --- | --- | --- |
| App hosting | Vercel/Docker | Vercel/Docker | Swarm + ENS |
| Data storage | PGlite + Swarm + Switchboard | PGlite + Swarm | PGlite + Swarm |
| Sync | DocSync via GraphQL | Swarm feed polling | Swarm feed polling |
| GraphQL API | Switchboard provides | In-browser reactor only | In-browser reactor only |
| Server needed | Yes (Switchboard) | No (Bee node only) | No (Bee node only) |
| ENS domain | No | No | Yes |
| Connect changes | 5 lines in reactor.ts | 5 lines + remove ChannelScheme | + HashRouter + Bee URL config |
| Multi-user collab | Via Switchboard | Via shared Swarm feeds | Via shared Swarm feeds |

### Implementation Priority

1. **Phase 1-6** (from above): Build the adapter itself — works for all modes
2. **Mode 1** (Hybrid): Easiest to test — just add adapter to existing Connect+Switchboard
3. **Mode 2** (Swarm Only): Remove ChannelScheme, add feed polling hydrator
4. **Mode 3** (Full Swarm): Add HashRouter, Swarm deployment scripts, ENS setup

## Identity Integration: Renown + Swarm

### Verified: Renown Identity Already on Swarm

Every operation uploaded to Swarm already carries the user's full Renown identity. Verified with live data from user `0xadbA7C2F82139031D7564D18aC22D09B12A0BcA4`:

```json
{
  "action": {
    "type": "SET_MODEL_NAME",
    "input": { "name": "My Model" },
    "context": {
      "signer": {
        "user": {
          "address": "0xadbA7C2F82139031D7564D18aC22D09B12A0BcA4",
          "networkId": "eip155",
          "chainId": 1
        },
        "app": {
          "name": "connect",
          "key": "did:key:zDnaetGR7SykLzxkKtH2LoDdNXEQXzg77Sb711T2yvPn4jCAk"
        },
        "signatures": [["timestamp", "did", "hash", "", "0xsig..."]]
      }
    }
  }
}
```

Two layers of identity on every Swarm-stored operation:
1. **Renown P-256 signature** — proves who authored the operation
2. **Swarm feed ownership (secp256k1)** — proves who stored it

### What's Missing: User-Level Document Discovery

Currently each document has its own manifest on Swarm, but there's no way to answer: "given Ethereum address `0xadbA...`, what documents does this user have?"

### Solution: User Manifest on Swarm

A **user-level manifest** keyed by Ethereum address that indexes all documents belonging to that user:

```
Swarm data model with user identity:

User 0xadbA7C2F...
  └─ User Manifest: Topic("ph:user:0xadbA7C2F...")
     {
       address: "0xadbA7C2F82139031D7564D18aC22D09B12A0BcA4",
       drives: {
         "preview-20d76a2a": {
           name: "My Drive",
           documents: ["98f040ff-...", "d504d3f8-..."]
         }
       },
       stamps: {
         "c15411cf...": { batchTTL: 86400, usedCapacity: "12%", lastChecked: "..." }
       },
       updatedAt: "2026-04-06T..."
     }
  └─ Doc Manifest: Topic("ph:doc:98f040ff-...")
     { documentId, operationBatches: [...], keyframes: [...] }
  └─ Doc Manifest: Topic("ph:doc:d504d3f8-...")
     { documentId, operationBatches: [...], keyframes: [...] }
```

### Implementation: SwarmSyncReadModel Extension

The `SwarmSyncReadModel` already receives every operation. Extend it to:

1. **Extract `signer.user.address`** from each operation's context
2. **Maintain a user manifest** that lists all documents this user has touched
3. **Upload the user manifest** to Swarm keyed by the user's address

```typescript
// In SwarmSyncReadModel.indexOperations():
for (const op of operations) {
  const userAddress = op.operation.action?.context?.signer?.user?.address;
  if (userAddress) {
    await this.updateUserManifest(userAddress, op.context.documentId, op.context.documentType);
  }
}
```

### Login Flow: User Opens Connect with Swarm

```
1. User opens Connect
2. Renown initializes → app P-256 key loaded from IndexedDB
3. User clicks "Log in" → Renown portal → wallet signature → redirect back
   → renown.user.address = "0xadbA7C2F..."
4. SwarmClient reads user manifest: Topic("ph:user:0xadbA7C2F...")
   → discovers: ["98f040ff-...", "d504d3f8-..."] in drive "My Drive"
5. For each document, reads doc manifest: Topic("ph:doc:98f040ff-...")
   → downloads operation batches from /bytes
   → loads into reactor via reactor.load()
6. User sees their Swarm-stored documents in Connect
7. User edits → ops signed by Renown → uploaded to Swarm → user manifest updated
8. Same wallet on another device → same user manifest → same documents
```

### Swarm Signer Key Derivation (Finalized Design)

**The curve mismatch:** Renown uses P-256 (secp256r1). Swarm requires secp256k1. The Renown app key cannot be reused directly for Swarm ECDH/ACT.

**The Renown key is per-device:** Each Connect instance generates its own P-256 key in IndexedDB. The key is NOT portable across devices (unlike the user's Ethereum wallet).

**Solution: One-time wallet signature, then automatic**

```
FIRST TIME on a device (or after browser data clear):
  1. User logs in with Renown → wallet connected
  2. Connect checks IndexedDB for cached Swarm key → not found
  3. Prompts: "Enable Swarm storage? Sign to authorize"
  4. User signs ONCE with MetaMask:
     personal_sign("Authorize Swarm storage for Powerhouse Connect\n
                    Address: 0xadbA7C2F...\n
                    Origin: https://connect.example.com\n
                    Chain: 1")
  5. Derive: swarmPrivateKey = keccak256(signature)
  6. Store derived key in IndexedDB (key: "swarm-signer")
  7. Initialize Bee client with derived key
  8. All operations now encrypted/signed with this key

SUBSEQUENT SESSIONS on same device:
  1. User logs in with Renown (automatic, no popup)
  2. Connect loads Swarm key from IndexedDB → found
  3. Bee client initialized automatically — no wallet popup
  4. Fully seamless, same as today

AFTER BROWSER DATA CLEAR or NEW DEVICE:
  1. IndexedDB wiped → Swarm key gone
  2. User logs in → step 2 above: key not found
  3. Wallet signature prompted again
  4. SAME wallet + SAME message → SAME derived key
  5. Same ACT access, same feeds, same documents
  6. Data on Swarm is NOT lost — only local cache/key was cleared
```

**Why this is secure:**
- The derived key is deterministic (same wallet = same key everywhere)
- The raw wallet private key is never exposed
- The message includes origin domain to prevent cross-site key derivation
- IndexedDB cache is convenience only — can always re-derive

**Storage in IndexedDB:**
```typescript
// Stored alongside Renown's key in IndexedDB
{
  db: "swarmKeyDB",
  store: "keys",
  entry: {
    swarmPrivateKey: "0x...",       // hex secp256k1 private key
    swarmPublicKey: "0x...",        // derived public key
    ownerAddress: "0xadbA7C2F...",  // Ethereum address that signed
    derivedAt: "2026-04-06T...",    // when the key was derived
  }
}
```

### Implementation Phases (updated)

**Done:**
1. [x] User manifest type + storage (`SwarmUserManifest` in types.ts)
2. [x] `SwarmSyncReadModel` extracts user address, maintains user manifest on Swarm
3. [x] Stamp status API (`SwarmClient.getStampStatus()`)

**Next:**
4. [ ] `SwarmConnectPlugin` — browser plugin subscribing to Renown login events
5. [ ] Wallet-derived signer — `personal_sign` → keccak256 → secp256k1 key, cached in IndexedDB
6. [ ] ACT encryption — `{ act: true }` on uploads, per-user encryption
7. [ ] User manifest discovery on login — read from Swarm, load documents
8. [ ] Document hydration — download ops from Swarm, load into reactor
9. [ ] Connect settings UI — stamp status, document list, sharing controls
10. [ ] E2E test: fresh start → login → derive key → create doc → clear browser → restart → login → re-derive → verify same docs accessible

## Postage Stamp Management

### The Problem

Swarm postage stamps have a **TTL (Time To Live)**. When a stamp expires, all data uploaded with it becomes unretrievable. Users need visibility into their storage status and the ability to extend it.

### Stamp Lifecycle

```
Buy stamp (xBZZ payment)
  → batchTTL starts counting down
  → upload data using this stamp
  → TTL decreases as blocks are mined (~5s per block on Gnosis)
  → when TTL reaches 0: data is garbage collected
```

### bee-js API for Stamp Management

```typescript
const bee = new Bee('http://localhost:1633');

// Check stamp status
const batch = await bee.getPostageBatch(batchId);
// batch.batchTTL — seconds remaining
// batch.utilization — how full the stamp is (0-100%)
// batch.usable — boolean, can still upload with this stamp
// batch.amount — remaining balance in PLUR
// batch.depth — determines max capacity (2^depth chunks)

// Buy storage (high-level API)
const batchId = await bee.buyStorage(
  Size.fromGigabytes(1),    // how much space
  Duration.fromDays(30),    // how long to keep it
);

// Extend TTL (top up)
await bee.topUpBatch(batchId, additionalAmount);

// Increase capacity (dilute)
await bee.diluteBatch(batchId, newDepth);

// List all stamps
const stamps = await bee.getAllPostageStamps();
```

### User Storage Dashboard

A storage status component in Connect that shows:

```
┌─────────────────────────────────────────┐
│  Swarm Storage                          │
│                                         │
│  Status: Active                         │
│  Storage used: 47 MB / 1 GB (4.7%)     │
│  Time remaining: 28 days               │
│  ████████████░░░░░░░░ 47%              │
│                                         │
│  Documents: 12                          │
│  Operations stored: 347                 │
│                                         │
│  [Top Up Storage]  [Buy More Space]     │
│                                         │
│  ⚠ Warning at 7 days remaining         │
│  ⚠ Critical at 1 day remaining         │
└─────────────────────────────────────────┘
```

### Implementation Plan

**Phase 1: Stamp Status API** (adapter-level)

Add to `SwarmClient`:

```typescript
class SwarmClient {
  async getStampStatus(): Promise<StampStatus> {
    const batch = await this.bee.getPostageBatch(this.batchId);
    return {
      batchId: this.batchId,
      usable: batch.usable,
      ttlSeconds: batch.batchTTL,
      ttlHuman: formatDuration(batch.batchTTL),
      utilization: batch.utilization,
      capacityBytes: calculateCapacity(batch.depth),
      expiresAt: new Date(Date.now() + batch.batchTTL * 1000).toISOString(),
    };
  }

  async topUpStamp(additionalAmount: bigint): Promise<void> {
    await this.bee.topUpBatch(this.batchId, additionalAmount);
  }

  async expandStamp(newDepth: number): Promise<void> {
    await this.bee.diluteBatch(this.batchId, newDepth);
  }
}
```

**Phase 2: Stamp status in user manifest**

Store stamp info in the user manifest so it's visible across devices:

```typescript
type SwarmUserManifest = {
  address: string;
  drives: Record<string, { name: string; documents: string[] }>;
  stamps: Record<string, {
    batchTTL: number;
    utilization: number;
    lastChecked: string;
    warningThresholdDays: number;
  }>;
};
```

**Phase 3: Warning system**

The `SwarmSyncReadModel` periodically checks stamp TTL and:
- Logs warnings when TTL < 7 days
- Logs critical alerts when TTL < 1 day
- Emits events that Connect can display as toast notifications

```typescript
async checkStampHealth(): Promise<StampHealthStatus> {
  const status = await this.swarmClient.getStampStatus();
  if (status.ttlSeconds < 86400) return "critical";    // < 1 day
  if (status.ttlSeconds < 604800) return "warning";    // < 7 days
  return "healthy";
}
```

**Phase 4: Buy/Top-up UI in Connect**

A React component using bee-js:

```typescript
// Buy new storage
const batchId = await bee.buyStorage(
  Size.fromGigabytes(1),
  Duration.fromDays(30),
);

// Top up existing
await bee.topUpBatch(existingBatchId, BZZ.fromPLUR('500000000'));
```

This requires the user's wallet to have xBZZ tokens on Gnosis chain. The UI would:
1. Show current stamp status (TTL, capacity, usage)
2. Estimate cost for extending (based on current Swarm price)
3. Call `bee.topUpBatch()` or `bee.buyStorage()` (triggers wallet transaction)
4. Update user manifest with new stamp info

### Stamp Strategies

| Strategy | Who pays | Complexity | Decentralization |
| --- | --- | --- | --- |
| **Shared stamp (MVP)** | App operator | Low — single env var | Centralized |
| **User-owned stamps** | Each user | Medium — wallet + xBZZ | Fully decentralized |
| **Sponsored stamps** | Organization | Medium — provisioning API | Semi-decentralized |
| **Stamp pool** | Shared fund | High — smart contract | DAO-governed |

MVP: shared stamp via env var (current). Next: user-owned stamps with wallet integration.

## Connect App UI Changes

The Renown identity + stamp management features require UI additions to the Connect app. This means forking `@powerhousedao/connect` (or contributing upstream) and publishing as `@liberuum-org/connect`.

### Swarm Settings Panel

A new section in Connect's settings (alongside existing Renown/profile settings):

```
Settings > Swarm Storage
┌─────────────────────────────────────────────────┐
│  Swarm Storage                                  │
│                                                 │
│  Bee Node: http://localhost:1633  [Connected]    │
│  Feed Owner: 0xadbA7C2F...82A4                  │
│                                                 │
│  ── Storage Status ──────────────────────────── │
│  Stamp: c154...3583                             │
│  Capacity: 47 MB / 1 GB used                   │
│  Time remaining: 28 days                        │
│  ████████████░░░░░░░░ 47%                      │
│                                                 │
│  [Top Up]  [Buy More Space]                     │
│                                                 │
│  ── Documents on Swarm ─────────────────────── │
│  12 documents across 2 drives                   │
│  347 operations stored                          │
│  Last sync: 2 minutes ago                       │
│                                                 │
│  ── Swarm Drives ────────────────────────────── │
│  📁 My Drive (8 docs)        [Load from Swarm]  │
│  📁 Shared Project (4 docs)  [Load from Swarm]  │
│                                                 │
│  [Disconnect Swarm]                             │
└─────────────────────────────────────────────────┘
```

### Swarm Drive Loading

When a user logs in and has documents on Swarm, Connect shows a notification:

```
┌──────────────────────────────────────┐
│  🐝 Swarm documents found           │
│                                      │
│  12 documents available from your    │
│  Swarm storage.                      │
│                                      │
│  [Load Documents]  [Dismiss]         │
└──────────────────────────────────────┘
```

Clicking "Load Documents" hydrates all documents from the user manifest into the local reactor.

### Connect UI Implementation Plan

1. **Swarm settings component** — new React component in Connect's settings page
   - Bee node URL config (editable)
   - Stamp status display (TTL, capacity, usage bar)
   - Top-up / buy buttons (triggers wallet transaction)
   - Document count from user manifest

2. **Swarm drive sidebar** — in the drive list, show Swarm-backed drives with a bee icon
   - Distinguish local-only drives from Swarm-persisted drives
   - "Load from Swarm" action for drives not yet in local storage

3. **Login hook extension** — after Renown login, check Swarm for user manifest
   - If found: show notification with document count
   - Auto-hydrate or prompt user

4. **Status indicator** — small bee icon in the header bar
   - Green: connected to Bee node, stamp healthy
   - Yellow: stamp TTL < 7 days
   - Red: stamp TTL < 1 day or Bee node unreachable

### Packages That Need Changes

| Package | Change | Published as |
| --- | --- | --- |
| `@powerhousedao/connect` | Swarm settings panel, drive loading, login hook | `@liberuum-org/connect` |
| `@powerhousedao/reactor-browser` | Swarm user manifest discovery on login | `@liberuum-org/reactor-browser` |
| `@powerhousedao/design-system` | Bee icon, stamp status components | May not need fork — use custom components |
| `@liberuum-org/bee-reactor-adapter` | User manifest type, stamp status API | Update existing package |

### Two Identity Tracks

**Track A: Switchboard Mode (working today)**
- Switchboard owns Swarm feeds via `SWARM_SIGNER_KEY` env var
- All users' documents go under one shared namespace
- Non-logged-in users: ops uploaded without `user.address` in signer context
- Logged-in users: ops have `user.address` embedded but Switchboard owns the feeds
- No wallet needed from users — Switchboard operator manages stamps and Bee node
- Documents discoverable by drive ID (same as current Powerhouse)

**Track B: Client Reactor Mode (the sovereign option)**
- No Switchboard — Connect runs a browser reactor with Swarm storage
- User MUST be logged in with Renown (forced login before any document operations)
- `personal_sign` derives a Swarm signer key from the user's wallet
- User owns their own feeds: `Topic("ph:user:0xadbA...")`
- User pays for their own stamps with xBZZ from their wallet
- Documents discoverable by Ethereum address across any device
- Fully decentralized — no servers, no shared keys, no operator

**Why forced login in Track B?** Without a wallet:
- No secp256k1 key → can't sign Swarm feeds
- No address → can't key the user manifest
- No xBZZ → can't pay for stamps
The wallet IS the identity, the signer, and the payment method. Anonymous usage doesn't make sense in this mode.

### Implementation Order

1. **Backend first** — user manifest in adapter, stamp status API (no UI needed)
2. **Connect settings** — static display of stamp status and document count
3. **Login hook** — auto-discover user documents from Swarm on Renown login
4. **Drive loading** — hydrate Swarm documents into local reactor
5. **Wallet-derived signer** — `personal_sign` for per-user feed ownership (Track B)
6. **Stamp management** — buy/top-up with wallet integration
7. **Status indicator** — header bar icon with health status
8. **Forced login gate** — Connect requires Renown login before Swarm operations (Track B)

## Swarm Data Model

### Per-Document Feed Manifest
```typescript
type SwarmDocumentManifest = {
  documentId: string;
  documentType: string;
  latestRevision: Record<string, number>;  // scope -> revision
  operationBatches: Array<{
    reference: string;    // Swarm content hash
    scope: string;
    branch: string;
    startIndex: number;
    endIndex: number;
    timestamp: string;
  }>;
  keyframes: Array<{
    reference: string;
    scope: string;
    branch: string;
    revision: number;
  }>;
  updatedAt: string;
};
```

### Why one feed per document?
- Feed payload limit is 4KB inline (bee-js handles overflow automatically)
- Independent document lifecycle
- Parallel polling for multi-document hydration

## File Structure

```
bee-reactor-adaptor/
  src/
    index.ts                      # Public exports
    bee-reactor-adapter.ts        # Main orchestrator
    swarm-client.ts               # Bee SDK wrapper
    swarm-operation-store.ts      # IOperationStore implementation
    swarm-keyframe-store.ts       # IKeyframeStore implementation
    swarm-hydrator.ts             # Startup sync from Swarm
    retry-queue.ts                # Failed upload retry with backoff
    types.ts                      # SwarmDocumentManifest, config
  tests/
    swarm-client.test.ts
    swarm-operation-store.test.ts
    integration.test.ts           # E2E with real Bee node
  package.json
  tsconfig.json
```

## Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Swarm upload latency (~200ms) blocks writes | Fire-and-forget with retry queue; local SQL write is synchronous and fast |
| Feed manifest grows unbounded | Compact after keyframe: remove batch entries older than latest keyframe |
| Postage stamp runs out | Check balance before uploads, warn when low |
| ReactorBuilder change rejected upstream | Alternative: construct Reactor directly (bypass builder), as tests already do |
| Local SQL and Swarm get out of sync | Hydrator compares on startup; retry queue ensures eventual consistency |

## Dev Mode Testing (Local Bee Node)

### Why bee-js?

`@ethersphere/bee-js` (v11.1.1) is the official TypeScript SDK, actively maintained (last update Feb 2026), works in browser + Node.js, provides full type safety, and powers both swarm-cli and Swarm Desktop. It covers all endpoints we need (`/bytes`, `/feeds`, `/stamps`). Using direct HTTP/fetch would mean reimplementing serialization, error handling, and feed signing logic that bee-js already provides. bee-js is the right choice.

### Running a Bee Dev Node

```bash
bee dev
```

This starts a **memory-only** Bee node on `http://localhost:1633` with:
- All backends mocked (no blockchain, no real xBZZ tokens needed)
- Full HTTP API on port 1633
- Postage stamps work (test stamps, not real)
- Upload/download to memory (data lost on restart)
- No networking config needed

Verify it's running:

```bash
curl -s http://localhost:1633/health | jq
# { "status": "ok", "version": "...", "apiVersion": "..." }
```

Get a test postage stamp:

```bash
# In dev mode, buy a stamp (fake tokens)
curl -s -X POST http://localhost:1633/stamps/10000000/24 | jq
# Returns: { "batchID": "abc123..." }
```

### Integration Test Strategy

Tests run against `bee dev` node. Test lifecycle:

1. **Before all**: Start `bee dev` (or expect it already running on `:1633`)
2. **Test SwarmClient**: Upload bytes, download bytes, create/update feeds, read feeds
3. **Test SwarmOperationStore**: Write operations, verify they appear on both local SQL and Swarm `/bytes`, verify feed manifest is updated
4. **Test SwarmKeyframeStore**: Write keyframe, verify Swarm upload, verify local cache
5. **Test SwarmHydrator**: Populate Swarm with ops from one store, create fresh store, hydrate, verify all ops present
6. **Round-trip**: Full reactor with adapter -> write docs -> kill reactor -> new reactor with fresh SQL -> hydrate from Swarm -> verify identical state

### Dev Environment Setup

```bash
# Terminal 1: Start dev Bee
bee dev

# Terminal 2: Run adapter tests
cd bee-reactor-adaptor
pnpm install
pnpm test              # Unit tests (mocked Bee)
pnpm test:integration  # Integration tests (requires bee dev running)
```

Note: `bee dev` stores everything in memory. Restarting it clears all data. This is perfect for test isolation — each test run starts clean.

## Verification Plan

1. **Unit tests**: Mock Bee SDK, verify SwarmOperationStore writes to both local + Swarm
2. **Integration test**: Against `bee dev` node — write ops, verify Swarm persistence, hydrate fresh reactor
3. **Connect E2E**: Run Connect with adapter, create/edit documents, verify Swarm round-trip
4. **Production test**: Against DappNode Bee node (`http://100.121.241.25:1633/`) with real postage stamp

## Critical Source Files

| Purpose | File |
|---|---|
| Storage interfaces | `reactor/src/storage/interfaces.ts` |
| ReactorBuilder (modify) | `reactor/src/core/reactor-builder.ts` (lines 221-226) |
| ReactorModule type | `reactor/src/core/types.ts` (line 423) |
| KyselyOperationStore (reference impl) | `reactor/src/storage/kysely/store.ts` |
| KyselyKeyframeStore (reference impl) | `reactor/src/storage/kysely/keyframe-store.ts` |
| Connect reactor setup | `apps/connect/src/utils/reactor.ts` |
| Planned Swarm store | `reactor/docs/archive/planning-v1/Storage/IOperationStore.md` (line 25) |
| IReadModel interface | `reactor/src/read-models/interfaces.ts` |
| Bee SDK | `swarm/bee-js/src/bee.ts` |
| Feed reader/writer | `swarm/bee-js/src/feed/` |
| ACT grantee API | `swarm/bee-js/src/modules/grantee.ts` |
| ACT access control (Go) | `swarm/bee/pkg/accesscontrol/` |
| ACT integration test | `swarm/bee-js/test/integration/act.spec.ts` |

## CORS Configuration

Connect (browser) needs to reach the Bee node API. CORS must be configured on the Bee node.

### Bee CORS flag

```bash
bee dev --cors-allowed-origins "*"                    # dev (allow all)
bee start --cors-allowed-origins "http://localhost:3001,https://yourapp.eth.limo"  # production
```

All Swarm headers are already in the CORS allowed list (including `Swarm-Act`, `Swarm-Act-Publisher`, `Swarm-Act-History-Address`, `Swarm-Postage-Batch-Id`, etc.). Verified in `bee/pkg/api/api.go:584-592`.

### Scenarios

| Connect origin | Bee node location | CORS needed | Config |
| --- | --- | --- | --- |
| `http://localhost:3001` | `http://localhost:1633` | Yes (different port) | `--cors-allowed-origins "http://localhost:3001"` |
| `http://localhost:3001` | `http://100.121.241.25:1633` (Tailscale) | Yes | `--cors-allowed-origins "http://localhost:3001"` |
| `https://yourapp.eth.limo` | User's DappNode | Yes | `--cors-allowed-origins "https://yourapp.eth.limo"` |
| Same origin (proxy) | Behind reverse proxy on same domain | No | N/A |

### For testing

Always start `bee dev` with CORS enabled:

```bash
bee dev --cors-allowed-origins "*"
```

## Encryption Architecture Decision: App-Layer AES-256-GCM

### Decision

**Encrypt data at the application layer using AES-256-GCM with the user's wallet-derived key. Do NOT rely on Swarm ACT for user privacy.**

### Why not ACT?

| Problem | ACT | App-layer |
| --- | --- | --- |
| Multiple users on same Switchboard | All share one Bee node key — NO privacy between users | Each user has own wallet-derived key — full privacy |
| User loses Bee node | ACT key is lost forever — data unrecoverable | Wallet derives same key — data always recoverable |
| Public gateway | ACT disabled — can't encrypt/decrypt | Fine — data encrypted before upload |
| Different Bee nodes | Each node has different key — can't decrypt cross-node | Doesn't matter — encryption is wallet-based |
| Cross-device | Need same Bee node from all devices | Same wallet = same key from any device |

### How app-layer encryption works

```
Upload (encrypt):
  1. User has wallet-derived key (from personal_sign → keccak256)
  2. Generate random IV (12 bytes) per upload
  3. AES-256-GCM encrypt(data, wallet_derived_key, iv)
  4. Upload to Swarm: iv + ciphertext (plain /bytes, no ACT)
  5. Any Bee node, any gateway — just stores encrypted bytes

Download (decrypt):
  1. Download encrypted bytes from any Bee node/gateway
  2. Extract iv (first 12 bytes)
  3. AES-256-GCM decrypt(ciphertext, wallet_derived_key, iv)
  4. Return plaintext

Cross-device:
  Same wallet → same personal_sign message → same derived key → same decryption

User loses Bee node:
  Wallet still works → derive key → decrypt from any other Bee node or gateway

Sharing (Alice → Bob):
  1. Alice encrypts data with her key (as normal)
  2. For sharing: Alice re-encrypts the document key with Bob's public key
     (ECDH between Alice's derived key and Bob's derived public key)
  3. Stores the encrypted document key alongside the document manifest
  4. Bob derives his key from his wallet, performs ECDH to get the shared key
  5. Bob decrypts the document key → decrypts the document
```

### Crypto primitives

All available in Web Crypto API (browser) and Node.js `crypto`:

```typescript
// Encryption
const iv = crypto.getRandomValues(new Uint8Array(12));
const key = await crypto.subtle.importKey("raw", walletDerivedKey, "AES-GCM", false, ["encrypt"]);
const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
const encrypted = concat(iv, new Uint8Array(ciphertext)); // 12 + N bytes

// Decryption
const iv = encrypted.slice(0, 12);
const ciphertext = encrypted.slice(12);
const key = await crypto.subtle.importKey("raw", walletDerivedKey, "AES-GCM", false, ["decrypt"]);
const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
```

No external crypto libraries needed. AES-GCM provides both confidentiality and authentication (tamper detection).

### Where ACT still has a role

ACT remains available in the API (`uploadData({ act: true })`, `grantAccess()`, etc.) for users who:
- Run their own dedicated Bee node
- Want node-level encryption in addition to app-layer encryption
- Want to use Swarm's native sharing model

But **app-layer encryption is the default and primary privacy mechanism.** ACT is optional and additive.

### Implementation plan

1. Create `SwarmCrypto` module — `encrypt(data, key)` / `decrypt(data, key)` using AES-256-GCM
2. Update `SwarmSyncReadModel` — encrypt operation batches before upload when user has a derived key
3. Update `SwarmHydrator` — decrypt operation batches after download
4. User manifest is also encrypted (only the owner can read their document index)
5. Sharing — ECDH between wallet-derived keys to produce shared document keys

## ACT Access Control (Private Documents)

### Overview

Swarm's Access Control Trie (ACT) enables per-user encryption using the Bee node's secp256k1 key. Each user's Bee node holds its own private key. Sharing is done by adding the recipient's Bee node public key to the grantee list.

### How ACT Works

```
Upload with ACT:
  data → encrypt with random access key → store on Swarm
  access key → encrypt per-grantee using ECDH(publisher, grantee) → store in ACT
  ACT → store in history (versioned, timestamped)
  
Download with ACT:
  grantee provides their private key → ECDH derives lookup key
  → retrieves encrypted access key from ACT → decrypts it
  → decrypts content reference → downloads content
  
Only grantees in the ACT can derive the correct lookup key.
```

### bee-js API

```typescript
// Upload encrypted (only publisher can read by default)
const result = await bee.uploadData(batchId, data, { act: true });
// result.reference = encrypted reference
// result.historyAddress = ACT history ref (needed for download + sharing)

// Grant access to specific Ethereum public keys
await bee.patchGrantees(batchId, granteeRef, historyRef, {
  add: [recipientPublicKey1, recipientPublicKey2],
});

// Revoke access (re-encrypts with new access key for remaining grantees)
await bee.patchGrantees(batchId, granteeRef, historyRef, {
  revoke: [revokedPublicKey],
});

// Download (only works if caller's key is in the grantee list)
const data = await bee.downloadData(encryptedRef, {
  actPublisher: publisherPublicKey,
  actHistoryAddress: historyRef,
});

// List current grantees (publisher only)
const grantees = await bee.getGrantees(granteeRef);
```

### Integration with Our Adapter

**Current (public):**
```
SwarmSyncReadModel.uploadOps()
  → bee.uploadData(batchId, payload)         // public, anyone can read
  → bee.uploadData(batchId, manifestJson)    // public manifest
```

**With ACT (private per user):**
```
SwarmSyncReadModel.uploadOps()
  → bee.uploadData(batchId, payload, { act: true })  // encrypted
  → store historyAddress in user manifest
  → user manifest itself encrypted with ACT (only owner can read)
```

### Privacy Levels

| Level | Who can read | How |
| --- | --- | --- |
| **Public** (current) | Anyone with the reference | No ACT, plain `/bytes` |
| **Owner-only** | Only the document creator | ACT with no grantees (default) |
| **Shared** | Owner + specific addresses | ACT with grantees added |
| **Team** | All members of a drive | ACT with all drive member addresses as grantees |

### Implementation Phases

**Phase 1: Private-by-default uploads**

Extend `SwarmClient.uploadData()` to optionally encrypt:

```typescript
class SwarmClient {
  async uploadData(data: string | Uint8Array, options?: { act?: boolean }): Promise<UploadResult> {
    const result = await this.bee.uploadData(this.batchId, data, {
      act: options?.act,
    });
    return {
      reference: result.reference.toHex(),
      historyAddress: result.historyAddress?.toHex(),
    };
  }
}
```

**Phase 2: Per-user encryption in SwarmSyncReadModel**

When a user's Ethereum address is detected, encrypt their ops with ACT:

```typescript
// In SwarmSyncReadModel.uploadOps():
if (userAddress && this.config.enableACT) {
  const result = await this.swarmClient.uploadDataWithACT(payload);
  // Store historyAddress in both document manifest and user manifest
  manifest.actHistoryAddress = result.historyAddress;
}
```

**Phase 3: Grantee management (sharing)**

Add sharing methods to `SwarmClient`:

```typescript
class SwarmClient {
  async shareDocument(documentId: string, recipientPublicKeys: string[]): Promise<void> {
    const manifest = await this.readManifest(documentId);
    await this.bee.patchGrantees(this.batchId, manifest.granteeRef, manifest.actHistoryAddress, {
      add: recipientPublicKeys,
    });
  }

  async revokeAccess(documentId: string, revokedPublicKeys: string[]): Promise<void> {
    const manifest = await this.readManifest(documentId);
    await this.bee.patchGrantees(this.batchId, manifest.granteeRef, manifest.actHistoryAddress, {
      revoke: revokedPublicKeys,
    });
  }
}
```

**Phase 4: Connect UI for sharing**

In the document settings or context menu:

```
┌─────────────────────────────────────────┐
│  Share Document                         │
│                                         │
│  🔒 Private (only you)                 │
│                                         │
│  Shared with:                           │
│  ✓ 0xadbA7C...82A4 (you)              │
│  ✓ 0x1234...5678 (alice.eth)    [x]    │
│  ✓ 0xabcd...ef01 (bob.eth)     [x]    │
│                                         │
│  [+ Add address]  [+ Add ENS name]     │
│                                         │
│  [Save]                                 │
└─────────────────────────────────────────┘
```

### Limitations

- **Bee dev mode**: ACT may not be fully supported. Need real Bee node for testing.
- **Timestamp granularity**: Cannot update grantee list twice in the same second.
- **Re-encryption on revoke**: Revoking access re-encrypts for all remaining grantees (can be slow with many grantees).
- **Key requirement**: Users need their Ethereum private key accessible for ECDH. In Track B (client reactor), this comes from the wallet-derived signer.
- **No ACT for feeds**: Feeds (SOC) don't support ACT natively. The content they point to can be ACT-encrypted, but the feed pointer itself is public.

### ACT + Renown + Swarm: The Full Picture

```
User logs in with Renown
  → wallet derives Swarm signer (secp256k1)
  → same key used for: feed signing, ACT encryption, grantee identity

User creates document
  → ops encrypted with ACT (owner-only by default)
  → user manifest encrypted with ACT
  → document manifest encrypted with ACT
  → all stored on Swarm, only owner can read

User shares document with alice.eth
  → resolve ENS to Ethereum address
  → add alice's public key to ACT grantee list
  → alice can now decrypt and read the document

User opens Connect on new device
  → logs in with same wallet
  → reads encrypted user manifest (ACT-decrypted with their key)
  → discovers all their documents
  → downloads and decrypts operation batches
  → full document state restored — private, sovereign, decentralized
```
