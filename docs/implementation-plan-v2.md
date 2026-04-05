# Bee Reactor Adapter - Implementation Plan

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

### Phase 1: ReactorBuilder Storage Injection

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

### Phase 2: Swarm Client Wrapper

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

### Phase 3: SwarmOperationStore

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

### Phase 4: SwarmKeyframeStore

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

### Phase 5: Swarm Hydrator (Startup Sync)

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

### Phase 6: Main Adapter + Connect Integration

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

### How Renown Works Today

When a user logs into Connect:

1. **App key** (ECDSA P-256) is generated and stored in IndexedDB (`BrowserKeyStorage`)
2. **User logs in** with their Ethereum address via `did:pkh:eip155:1:0x...`
3. A **Verifiable Credential** links the app's DID to the user's Ethereum address
4. Every operation gets signed with the app's P-256 key, and the user's identity is attached:

```typescript
// What gets attached to every operation:
action.context.signer = {
  user: {
    address: "0x...",      // User's Ethereum address
    networkId: "eip155",
    chainId: 1,
  },
  app: {
    key: "did:key:z...",   // App's P-256 DID
    name: "connect",
  },
  signatures: [signature],  // P-256 ECDSA signature of the action hash
}
```

### The Curve Mismatch

- **Renown app signing**: ECDSA **P-256** (secp256r1)
- **Swarm feeds**: ECDSA **secp256k1** (Ethereum curve)
- **User's Ethereum wallet**: **secp256k1**

The Renown app key **cannot** sign Swarm feeds directly (wrong curve). But the user's Ethereum identity is already on the right curve.

### Solution: Use the User's Ethereum Identity for Swarm Feed Ownership

The user's Ethereum address from Renown login becomes the Swarm feed owner. Two approaches:

**Approach A: Derive Swarm signer from user's wallet (recommended)**

When the user logs in via Renown, prompt them to also sign a Swarm authorization. This uses their Ethereum wallet (MetaMask, etc.) to derive a Swarm-specific key:

```typescript
// During Renown login in Connect:
const user = await renown.login(userDid);
// user.address = "0x1234..." (Ethereum address)

// Ask user to sign a deterministic message to derive a Swarm key
const swarmSeed = await ethereum.request({
  method: 'personal_sign',
  params: [
    `Authorize Swarm storage for Powerhouse Connect\nAddress: ${user.address}`,
    user.address,
  ],
});

// Derive a secp256k1 private key from the signature
// (deterministic: same wallet + same message = same key)
const swarmPrivateKey = keccak256(swarmSeed);

// This key becomes the Swarm feed signer
const beeAdapter = new BeeReactorAdapter({
  beeUrl: 'http://localhost:1633',
  batchId: stampId,
  signerPrivateKey: swarmPrivateKey,  // Derived from user's Ethereum wallet
});
```

The feed owner address will be deterministically derived from the user's Ethereum wallet, so:
- Documents stored by user A have feeds owned by user A's derived address
- Another user B with a different wallet gets different feeds
- The same user on a different device gets the **same** feeds (same wallet = same derived key)

**Approach B: Direct wallet signing (simpler but slower)**

Have the Bee adapter call the user's wallet for every feed update:

```typescript
// Each feed update goes through the wallet
const signer = {
  sign: async (data: Uint8Array) => {
    return ethereum.request({
      method: 'personal_sign',
      params: [data, user.address],
    });
  },
  address: user.address,
};

const bee = new Bee('http://localhost:1633', { signer });
```

This is simpler but requires a wallet popup for every feed update. Approach A is better for UX.

### Flow: User Opens Connect with Swarm

```
1. User opens Connect (served from Swarm or Vercel)
2. Renown initializes → app P-256 key loaded from IndexedDB
3. User clicks "Log in" → Renown login with Ethereum DID
   → user.address = "0x1234..."
4. User authorizes Swarm storage (one-time wallet signature)
   → derives Swarm signer key
5. BeeReactorAdapter initializes with:
   - beeUrl from config
   - signerPrivateKey from wallet derivation
   - batchId from user's postage stamps
6. Reactor starts → hydrates from Swarm feeds owned by this user
7. User creates/edits documents → ops signed by Renown P-256 key
   → uploaded to Swarm under user's Ethereum-derived feed ownership
8. Another device with same wallet → same feeds → same documents
```

### Postage Stamps per User

Each user needs their own postage stamps to upload to Swarm. Options:

1. **User buys stamps**: In the Connect UI, add a "Buy Storage" button that calls `bee.buyStorage()`. User pays with xBZZ from their wallet.

2. **Shared stamps**: The app operator provides a stamp batch ID. All users share it. Simpler but centralized.

3. **Stamp marketplace**: Future — a service that sells stamps and provisions them per user.

For MVP, option 2 (shared stamps) is simplest. For the full decentralized vision, option 1.

### What Gets Stored on Swarm per User

```
User A (0x1234...)
  └─ Feed: Topic("ph:doc:drive-id-1")  Owner: derived(0x1234)
     └─ Manifest: {
          documents: {
            "doc-abc": { feed: Topic("ph:doc:doc-abc"), latestRevision: {...} },
            "doc-def": { feed: Topic("ph:doc:doc-def"), latestRevision: {...} },
          }
        }
  └─ Feed: Topic("ph:doc:doc-abc")  Owner: derived(0x1234)
     └─ Manifest: { operationBatches: [...], keyframes: [...] }
       └─ /bytes/ref1: [operation batch JSON, signed by user A's Renown key]
       └─ /bytes/ref2: [keyframe JSON]
```

Every operation inside the batch still carries the Renown P-256 signature on the action, proving user A authored it. The Swarm feed ownership (secp256k1) proves user A stored it. Two layers of identity.

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
