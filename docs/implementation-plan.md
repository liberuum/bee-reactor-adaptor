# Implementation Plan

## Phase 1: Core Storage Interface (Week 1)

Create `BeeReactorStorage` class implementing:

```typescript
export class BeeReactorStorage implements IBeeReactorStorage {
  // Constructor
  constructor(config: BeeReactorConfig);

  // Write operations
  async writeOperations(docId, scope, branch, operations, revision);

  // Read operations
  async readOperations(docId, scope, branch, fromIndex?, toIndex?);
  async readLatestRevision(docId, scope, branch);

  // Keyframe operations
  async writeKeyframe(docId, scope, branch, revision, document);
  async findNearestKeyframe(docId, scope, branch, targetRevision);

  // Feed updates
  async updateDocumentFeed(docId, manifest);
  async getDocumentFeed(docId);
}
```

Key decisions:
- Chunking strategy (one file per operation vs batched operations)
- Feed topics per document vs single feed for all documents
- Local PGLite cache (for fast reads, rebuilds on startup)
- Conflict detection (check `prevOpId` matches before uploading)

## Phase 2: Test Upload/Download (Week 1-2)

Test with our DappNode Bee node:
1. Upload a test chunk → get hash
2. Download the same chunk → verify content matches
3. Create/update a feed → verify feed update works
4. Simulate operation write → download → rebuild state

## Phase 3: Reactor Integration (Week 2-3)

Integrate with `ReactorBuilder`:

```typescript
const beeStorage = new BeeReactorStorage({
  beeApiUrl: process.env.SWARM_BEE_API_URL,
  postageStampId: process.env.SWARM_POSTAGE_STAMP_ID,
  walletPrivateKey: process.env.SWARM_WALLET_PRIVATE_KEY,  // for feeds
});

const reactor = new ReactorBuilder()
  .withDocumentModels(models)
  .withKysely(kyselyDb)
  .withStorageAdapter(beeStorage)  // ← NEW
  .build();
```

## Phase 4: DocSync over Swarm (Week 3-4)

Sync between reactors via feed polling:
1. Subscribe to another reactor's feed
2. Poll for updates (every N seconds or via WebSocket)
3. Download new operations from `/bytes`
4. Replay operations → rebuild local state
5. If conflict: detect via hash chain mismatch

## Phase 5: Vault Migration (Week 4)

Test with actual vault data:
1. Export operations+keyframes from PGLite vault
2. Upload to Swarm
3. Verify state rebuild matches original
4. Performance benchmarks

## File Structure

```
bee-ractor-adaptor/
├── README.md
├── package.json
├── tsconfig.json
├── docs/
│   ├── architecture.md
│   ├── swarm-integration.md
│   └── implementation-plan.md
├── src/
│   ├── bee-ractor-storage.ts      # Main adapter class
│   ├── types.ts                     # Type definitions
│   ├── feed-manager.ts              # Feed update logic
│   ├── operation-chunks.ts          # Chunking strategy
│   ├── keyframe-chunks.ts           # Keyframe storage
│   ├── local-cache.ts               # PGLite rebuild cache
│   └── errors.ts                    # Custom error types
├── tests/
│   ├── bee-ractor-storage.test.ts
│   └── feed-manager.test.ts
└── scripts/
    └── upload-vault-to-swarm.ts     # Migration script
```
