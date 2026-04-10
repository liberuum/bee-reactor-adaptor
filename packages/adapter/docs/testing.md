# Swarm Adapter — Testing Guide

## Quick Start

```bash
cd bee-reactor-adaptor/packages/adapter

# Install dependencies
pnpm install

# Run unit tests (no Bee node needed, instant)
bunx vitest run tests/unit/

# Run all tests against a live Bee node
BEE_URL="https://your-bee-node:1633" bunx vitest run

# Run a specific test file
BEE_URL="https://your-bee-node:1633" bunx vitest run tests/integration/upload-tracking.test.ts

# Watch mode (re-runs on file changes)
BEE_URL="https://your-bee-node:1633" bunx vitest --watch
```

## Prerequisites

### For unit tests (no network)
- Node.js 18+ or Bun
- `pnpm install` in the adapter package

### For integration tests (live Bee node)
- A running Bee node (v2.7.1+ recommended) accessible via HTTP/HTTPS
- At least one usable postage stamp on the node
- Set the `BEE_URL` environment variable to your node's API endpoint

The tests automatically:
1. Check if the Bee node is healthy
2. Find a usable stamp (with enough capacity and TTL)
3. Log the node status and stamp health before running
4. Wait for feed propagation between writes and reads

## Test Structure

```
tests/
  helpers.ts                              — shared fixtures, preflight check, waitForFeed
  unit/
    bytes-utils.test.ts                   — hex/byte conversion (14 tests)
    swarm-crypto.test.ts                  — AES-256-GCM encrypt/decrypt (15 tests)
    wallet-signer.test.ts                 — key derivation, sign message (7 tests)
    types.test.ts                         — createEmptyManifest factory (4 tests)
  integration/
    feed-reference.test.ts                — uploadReference vs uploadPayload (5 tests)
    swarm-client-feeds.test.ts            — manifest CRUD via feeds, sharing (10 tests)
    upload-tracking.test.ts               — tag confirmation, node status, stewardship (8 tests)
    clear-cache.test.ts                   — clear storage flow (3 tests)
  integration.test.ts                     — full adapter flow: stores, hydrator, read model,
                                            encryption, wallet signer, stamps (18 tests)
```

## What Each Test File Covers

### Unit Tests (40 tests, no network, < 1 second)

| File | Tests | What it verifies |
|------|------:|-----------------|
| `bytes-utils.test.ts` | 14 | hexToBytes/bytesToHex roundtrips, concat, edge cases |
| `swarm-crypto.test.ts` | 15 | Encrypt/decrypt roundtrip, SWE prefix, wrong key fails, large data, random IV |
| `wallet-signer.test.ts` | 7 | Deterministic key derivation, sign message format |
| `types.test.ts` | 4 | Empty manifest factory, default documentType |

### Integration Tests (43 tests, live Bee node, ~2 minutes)

| File | Tests | What it verifies |
|------|------:|-----------------|
| `feed-reference.test.ts` | 5 | uploadReference vs uploadPayload format, size comparison (69% smaller), read/write mismatch detection |
| `swarm-client-feeds.test.ts` | 10 | Document/user/drive manifest write+read via feeds, multi-update, sharing encryption roundtrip, share manifest |
| `upload-tracking.test.ts` | 8 | Tag-based upload tracking with progress, deferred upload, network confirmation (synced==split), node status (mode/peers/reachable), stewardship availability check |
| `clear-cache.test.ts` | 3 | Full clear cycle (write → clear → verify empty → write new), recovery sees clean state, /bytes data survives clear |
| `integration.test.ts` | 18 | Operation store write-through, keyframe store, hydrator recovery, sync read model, user manifest identity, encrypted privacy flow, stamp status, wallet signer |

### Total: 84 tests (83 pass, 1 skipped)

The skipped test (`BeeReactorAdapter` full flow) is a Path B adapter test that has feed propagation timing issues on live nodes. Path B is not used by the Connect plugin — it's for potential server-side use.

## Preflight Health Check

Every integration test file runs a preflight check before any test executes. This validates:

1. **Node health** — is the Bee node reachable and reporting "ok"?
2. **Stamp availability** — does the node have at least one usable stamp?
3. **Stamp capacity** — warns if less than 1 MB remaining
4. **Stamp TTL** — warns if less than 1 hour remaining

Example output:
```
Bee node: https://your-node:1633 — ok
Stamp: 1f0afdf0503d... — 75% used, 26/102 MB free, TTL 5d
```

If the preflight fails, all tests in that file are skipped with a clear error message.

## Feed Propagation Handling

Live Bee nodes need time for SOC (feed) writes to propagate to the neighborhood. The tests handle this with:

- **`waitForFeed(fn, maxWaitMs, intervalMs)`** — polls a read function until it returns non-null, with configurable timeout (default 30s) and interval (default 3s)
- **`waitForPropagation(ms)`** — simple delay after writes that need to settle

These ensure tests don't fail due to network timing while keeping the test run as fast as possible.

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|:---:|---------|-------------|
| `BEE_URL` | For integration tests | `http://localhost:1633` | Bee node API endpoint (HTTP or HTTPS) |

### vitest.config.ts

```typescript
{
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,   // 60s per test (live node needs propagation time)
    hookTimeout: 30_000,   // 30s for beforeAll/afterAll
  }
}
```

Individual tests that need more time can set their own timeout:
```typescript
it("long test", { timeout: 120_000 }, async () => { ... });
```

## Debugging

### Console Output

All tests log their progress. Run with `--reporter=verbose` to see timestamps:

```bash
BEE_URL="https://your-node:1633" bunx vitest run --reporter=verbose
```

### Swarm Plugin Logs

In the browser, filter the console by `[SwarmPlugin]` to see all plugin activity:

```
[SwarmPlugin] Buffered 3 ops for "Q1 Budget" (abc12345..., flush in 3s)
[SwarmPlugin] Flushing 3 ops for "Q1 Budget" → ref:a1b2c3d4e5f6...
[SwarmPlugin] Confirmed "Q1 Budget" — 1/1 chunks in 1021ms
[SwarmPlugin] Manifest written for "Q1 Budget"
```

### Inspector Modal

Enable in Connect to browse the PGlite database and sync remotes:

```
https://connect-url.xyz/?FEATURE_INSPECTOR_ENABLED=true
```

### Runtime State

```javascript
// In browser console
window.ph.swarm.status           // "ready" | "disconnected" | "no-stamp"
window.ph.swarm.syncStatus       // Per-doc sync status
window.ph.swarm.stampStatus      // Stamp health details
window.ph.swarm.isDevMode        // Whether connected to bee dev

// Subscribe to events (no polling needed)
window.ph.swarm.on("sync:confirmed", (e) => console.log(e));
window.ph.swarm.on("sync:error", (e) => console.log(e));
window.ph.swarm.on("sync:all-synced", () => console.log("All synced!"));
```

## Key Invariants Verified by Tests

These properties are verified across the test suite and must always hold:

1. **Encryption before upload** — no plaintext reaches the Bee node
2. **Deterministic keys** — same wallet signature = same key on any device
3. **Upload confirmation** — tag tracking verifies `synced == split` (real neighborhood receipt)
4. **Feed write/read roundtrip** — uploadReference + downloadReference produces the same data
5. **Clear cache produces clean state** — user manifest has 0 drives, recovery finds nothing
6. **Old /bytes data survives clear** — content-addressed chunks are immutable until stamp expires
7. **Wrong decryption key fails** — GCM auth tag rejects wrong key
8. **Content availability** — stewardship API confirms data is retrievable
9. **Node status** — rich health info (mode, peers, reachability, reserve)
10. **Backward compatibility** — untracked uploads still work (no tagUid returned)
