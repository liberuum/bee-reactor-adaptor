# Swarm Adapter Testing Strategy

Comprehensive testing plan for the `@liberuum-org/bee-reactor-adapter` package.

## Debugging Tools

### Inspector Modal (PGlite Database Browser)

Connect has a built-in Inspector Modal that lets you browse the local PGlite database and inspect sync remotes. This is critical for debugging the Swarm adapter because you can see:

- **Operations table** — every operation stored locally, with index, hash, action, scope, branch
- **Documents table** — document headers, types, revisions
- **Relationships** — which documents belong to which drives
- **Remotes tab** — inbox/outbox/dead letter for sync channels

**How to enable:**

```bash
# Via URL parameter (recommended for quick testing)
https://connect-url.xyz/?FEATURE_INSPECTOR_ENABLED=true

# Via environment variable (local dev)
PH_CONNECT_INSPECTOR_ENABLED=true npm run dev
```

Once enabled, click the info icon in the Connect sidebar footer to open the modal.

**What to inspect during Swarm testing:**

| Table | What to check |
|-------|--------------|
| `operations` | Verify ops are stored with correct `index`, `scope`, `branch`, `hash` |
| `documents` | Verify document headers match what's on Swarm after recovery |
| `document_relationships` | Verify drive-document relationships after hydration |

You can also export the full database as SQL (`Export DB` button) for offline analysis.

### Console Logging

The plugin logs every significant action with the `[SwarmPlugin]` prefix. Filter the browser console:

```
[SwarmPlugin] Buffered 3 ops for "Q1 Budget" (abc12345..., flush in 3s)
[SwarmPlugin] Flushing 3 ops for "Q1 Budget" → ref:a1b2c3d4e5f6...
[SwarmPlugin] Manifest written for "Q1 Budget"
[SwarmPlugin] Drive manifest written for "Finance" (xyz78901..., 2 docs)
[SwarmPlugin] User manifest updated (1 drives)
```

### window.ph.swarm (Runtime State)

Open the browser console and inspect:

```js
// Current plugin state
window.ph.swarm.status           // "ready" | "disconnected" | "no-stamp" | ...
window.ph.swarm.client           // SwarmClient instance
window.ph.swarm.userManifest     // Current user manifest (drives, docs)
window.ph.swarm.syncStatus       // Per-doc sync status: { state, pendingOps, updatedAt }
window.ph.swarm.stampStatus      // Postage stamp health
window.ph.swarm.isDevMode        // Whether connected to bee dev

// Manual actions
await window.ph.swarm.clearStorage()
await window.ph.swarm.reconnect()
await window.ph.swarm.setBeeUrl("http://localhost:1633")
await window.ph.swarm.refreshBalances()
```

---

## Test Levels

### Level 1: Unit Tests (no network, fast)

Test individual modules with mock dependencies. These run in Node.js with no Bee node.

```
tests/
  unit/
    swarm-crypto.test.ts
    bytes-utils.test.ts
    wallet-signer.test.ts
    stamp-manager.test.ts
    share-manager.test.ts
    types.test.ts
    pending-ops-store.test.ts
```

#### swarm-crypto.test.ts

| Test | What it verifies |
|------|-----------------|
| `encrypt → decrypt roundtrip` | Same key encrypts and decrypts correctly |
| `SWE prefix detection` | `isEncrypted` returns true for encrypted data, false for plaintext |
| `wrong key fails` | `decrypt` throws on wrong key (GCM auth tag mismatch) |
| `deterministic prefix` | First 3 bytes are always `0x53 0x57 0x45` |
| `different IVs` | Two encryptions of same data produce different ciphertext |
| `encryptJSON → decryptJSON roundtrip` | Objects survive serialization + encryption |

#### bytes-utils.test.ts

| Test | What it verifies |
|------|-----------------|
| `hexToBytes → bytesToHex roundtrip` | Conversion is reversible |
| `0x prefix handling` | Both `0x` and raw hex work |
| `concatBytes` | Multiple arrays concatenated correctly with total length |
| `empty input` | Edge cases: empty hex string, empty array |

#### wallet-signer.test.ts

Uses injectable `EthereumProvider` — no real wallet needed.

| Test | What it verifies |
|------|-----------------|
| `buildSignMessage` | Deterministic message format with address and origin |
| `deriveSwarmKey` | Same signature always produces same key (deterministic) |
| `deriveSwarmKey` | Different signatures produce different keys |
| `requestSwarmKeyFromWallet` | Calls `eth_requestAccounts` then `personal_sign` on the provider |
| `requestSwarmKeyFromWallet` | Returns correct `SwarmSignerEntry` shape |
| `requestSwarmKeyFromWallet` | Throws when no provider available |

```typescript
// Mock provider for testing
const mockProvider: EthereumProvider = {
  async request({ method, params }) {
    if (method === "eth_requestAccounts") return ["0xabc..."];
    if (method === "personal_sign") return "0xfake_signature_hex...";
    throw new Error(`Unknown method: ${method}`);
  },
};
```

#### stamp-manager.test.ts

Uses a mock `Bee` instance (injectable via `SwarmClient` constructor).

| Test | What it verifies |
|------|-----------------|
| `getStampStatus` health thresholds | expired/critical/warning/healthy based on TTL |
| `estimateStampCost` math | Correct PLUR and xBZZ calculation for given depth/days |
| `getStampOptions` filtering | Only shows depths >= current batch depth |
| `getBzzUsdPrice` timeout | Returns null on timeout (does not throw) |

#### share-manager.test.ts

| Test | What it verifies |
|------|-----------------|
| `deriveShareKey` deterministic | Same addresses always produce same key |
| `deriveShareKey` order matters | `SHA-256(A:B)` !== `SHA-256(B:A)` |
| `deriveShareKey` address normalization | Case-insensitive, 0x-stripped |

#### types.test.ts

| Test | What it verifies |
|------|-----------------|
| `createEmptyManifest` | Returns correct shape with empty arrays, ISO timestamp |
| `createEmptyManifest` default documentType | Defaults to `""` when omitted |

#### pending-ops-store.test.ts

Uses a mock IndexedDB (e.g. `fake-indexeddb` package).

| Test | What it verifies |
|------|-----------------|
| `savePendingOps → loadAllPendingOps roundtrip` | Data survives write + read |
| `clearPendingOps` | Removes a single doc's ops |
| `clearAllPendingOps` | Wipes everything |
| `markPendingOpsExist / hasPendingOpsFlag` | Flag is user-scoped by address |
| `hasPendingOpsFlag` with wrong address | Returns false for different user |
| `idbWrite awaits commit` | Transaction completes before promise resolves |

---

### Level 2: Integration Tests (live Bee node)

Test end-to-end data paths against a real Bee node. Existing file: `tests/integration.test.ts` (12 tests, 1,351 lines).

```bash
# Start Bee in dev mode (memory-only, free stamps)
bee dev

# Or use the remote node for feed tests:
# https://dappnode-tailscale.tailcbc470.ts.net:1633/

# Run tests
pnpm test
```

#### Existing Tests (integration.test.ts)

Already covers: upload/download, manifest CRUD, encryption roundtrip, operation store write-through, keyframe store, hydrator, adapter lifecycle.

#### New Integration Tests to Add

```
tests/
  integration/
    manifest-flush.test.ts
    compaction.test.ts
    share-encrypt.test.ts
    pending-ops-replay.test.ts
```

| Test file | What it covers |
|-----------|---------------|
| `manifest-flush.test.ts` | Debounced doc/user/drive manifest writes; partial failure recovery; atomic flush (ops not lost on updateManifest failure) |
| `compaction.test.ts` | Upload 30 batches → `compactManifest` → verify single batch per scope/branch, same ops, correct index range |
| `share-encrypt.test.ts` | `uploadSharedData → downloadSharedData` with matching keys; verify mismatched keys throw; share manifest CRUD |
| `pending-ops-replay.test.ts` | Save ops to IndexedDB → simulate tab close → replay on startup → verify ops are flushed; verify already-synced ops are skipped |

---

### Level 3: User Flow E2E Tests

Test the 6 user flows through the plugin layer with a mock `reactorClient` and real `SwarmClient`.

```
tests/
  e2e/
    create-sync.test.ts
    recovery.test.ts
    share-import.test.ts
    clear-cache.test.ts
    reconnect.test.ts
    edge-cases.test.ts
```

#### Test: Create + Sync

```
1. Create a mock reactorClient that fires document change events
2. Initialize the plugin (initSwarmPlugin equivalent)
3. Fire a document edit event
4. Wait for debounce (3s)
5. Verify: ops uploaded to Swarm /bytes (encrypted)
6. Verify: document manifest updated with correct batch entry
7. Verify: drive manifest contains the document
8. Verify: user manifest lists the drive
```

#### Test: Recovery (Hydration)

```
1. Set up Swarm state: user manifest with 1 drive, drive manifest with 2 docs, doc manifests with ops
2. Create a fresh reactorClient with no local data
3. Call hydrateFromSwarm with the user manifest
4. Verify: 1 local drive created with correct name
5. Verify: 2 documents created in the drive
6. Verify: operations replayed on each document
7. Verify: folder structure restored (ADD_FOLDER + MOVE_NODE)
8. Verify: syncPaused is false after completion
9. Verify: clean user manifest written to Swarm
```

#### Test: Share + Import

```
1. Set up: 2 documents in a drive with pending ops, flush them to Swarm
2. Call shareDocumentsWithUser with recipient address
3. Verify: drive bundle uploaded (encrypted with shared key)
4. Verify: share manifest written to the share feed
5. Switch context to recipient's SwarmClient
6. Call importFromUser with sender's address
7. Verify: bundle downloaded and decrypted
8. Verify: new drive created with "(shared)" suffix
9. Verify: documents created with new IDs
10. Verify: folder structure restored from bundle metadata
```

#### Test: Clear Cache

```
1. Set up: synced state with 2 drives, 3 docs
2. Call clearSwarmStorage
3. Verify: empty manifests written to all drive feeds
4. Verify: empty user manifest written (identity preserved)
5. Verify: all in-memory state cleared
6. Verify: IndexedDB pending ops cleared
7. Verify: auto-reconnect triggered
8. Verify: syncPaused is false after reconnect
9. Create a new document
10. Verify: it syncs to the clean Swarm state
```

#### Test: Reconnect (Bee URL change)

```
1. Initialize with http://localhost:1633
2. Call setBeeUrl("http://newnode:1633")
3. Verify: old subscribers cleaned up (cleanupSync called)
4. Verify: new plugin started with new URL
5. Verify: fresh subscribers registered
6. Verify: hydration runs if drives exist on new node
7. Fire a document edit
8. Verify: ops uploaded to the NEW Bee node
```

#### Test: Edge Cases

| Test | Scenario |
|------|----------|
| `bee-node-offline` | Start plugin, Bee goes offline mid-sync. Verify: ops buffered, persisted to IndexedDB, no crash. Bee comes back: verify ops flushed on next sync event. |
| `rapid-edits` | 100 edits in 500ms. Verify: 1 /bytes upload + 1 feed write (not 100). |
| `concurrent-doc-edits` | Edit 5 docs simultaneously. Verify: max 5 concurrent flushes (throttle). All manifests correct. |
| `hmr-resilience` | Simulate HMR by calling swarmPluginProcessorBuilder twice. Verify: only 1 init runs (idempotency guard). |
| `tab-close-with-pending` | Buffer ops, simulate beforeunload. Verify: localStorage flag set. New session: verify ops replayed from IndexedDB. |
| `multi-user-same-browser` | User A buffers ops, tab closes. User B logs in. Verify: User B does NOT replay User A's ops (address-scoped flag). |
| `circular-folders` | Recovery with folder data containing cycles (A→B→C→A). Verify: no infinite recursion, folders created without crash. |
| `empty-drive-recovery` | User manifest lists a drive but drive manifest has 0 docs. Verify: drive created locally, syncPaused reset. |
| `partial-flush-failure` | uploadData succeeds but updateManifest fails. Verify: ops NOT lost from buffer, manifest NOT corrupted, retry succeeds. |
| `stamp-expired-mid-session` | Stamp expires during editing. Verify: uploads fail gracefully, ops buffered, no infinite retry loop. |

---

## Test Infrastructure

### Mock Factories

```typescript
// Mock reactor client for E2E tests
function createMockReactorClient() {
  const subscribers: Array<(event: any) => void> = [];
  const drives = new Map<string, any>();
  const docs = new Map<string, any>();

  return {
    subscribe(_filter: any, callback: (event: any) => void) {
      subscribers.push(callback);
      return () => { /* unsubscribe */ };
    },
    getDrives: async () => [...drives.values()],
    get: async (id: string) => docs.get(id) ?? drives.get(id),
    getChildren: async (driveId: string) => ({ results: [] }),
    getOperations: async (docId: string) => ({ results: [] }),
    getDocumentModelModule: async (type: string) => ({
      utils: { createState: () => ({ global: {}, local: {} }) },
    }),
    createDocumentInDrive: async (driveId: string, doc: any) => {
      docs.set(doc.header.id, doc);
    },
    execute: async (docId: string, branch: string, ops: any[]) => {},

    // Test helpers
    _fireEvent(event: any) {
      for (const sub of subscribers) sub(event);
    },
    _addDrive(id: string, name: string) {
      drives.set(id, { id, state: { global: { name, nodes: [] } } });
    },
  };
}

// Mock Bee instance for unit tests
function createMockBee() {
  const store = new Map<string, Uint8Array>();
  return {
    url: "http://mock:1633",
    async uploadData(_batchId: string, data: any) {
      const ref = crypto.randomUUID().replace(/-/g, "");
      store.set(ref, typeof data === "string" ? new TextEncoder().encode(data) : data);
      return { reference: { toHex: () => ref } };
    },
    async downloadData(ref: string) {
      const data = store.get(ref);
      if (!data) throw new Error("Not found");
      return { toUint8Array: () => data };
    },
    // ... add other methods as needed
  };
}
```

### Running Tests

```bash
# Unit tests (no Bee node needed)
pnpm vitest run tests/unit/

# Integration tests (requires bee dev on localhost:1633)
bee dev &
pnpm vitest run tests/integration/

# E2E flow tests (requires bee dev)
pnpm vitest run tests/e2e/

# All tests
pnpm test

# Watch mode for development
pnpm vitest --watch
```

### vitest.config.ts Setup

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    // Separate pools for unit vs integration
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
```

---

## Key Invariants to Test

These are the properties that must ALWAYS hold, regardless of timing, network state, or user actions:

1. **Encryption before upload** — no plaintext data ever reaches the Bee node
2. **Deterministic keys** — same wallet + same message = same key on any device
3. **No duplicate ops on recovery** — dedup by op ID or index
4. **syncPaused always resets** — every code path that sets `true` has a `finally` that sets `false`
5. **Manifest integrity** — partial flush failure cannot corrupt the in-memory manifest
6. **Feed write serialization** — one write per topic at a time (per-topic lock)
7. **User manifest serialization** — one read-modify-write per address at a time
8. **Document manifest serialization** — one read-modify-write per document at a time
9. **Pending ops survive tab close** — IndexedDB persistence + localStorage flag
10. **User isolation** — pending ops from User A are never replayed for User B
