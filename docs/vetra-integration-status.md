# Vetra Integration Status

## What Works

- **Adapter core**: All 9 E2E tests pass against `bee dev` (SwarmClient, SwarmOperationStore, SwarmKeyframeStore, SwarmHydrator, BeeReactorAdapter)
- **Standalone reactor test**: `test-project/scripts/test-swarm-reactor.ts` creates a real reactor with PGlite + Swarm write-through and it works end-to-end
- **Switchboard startup**: Vetra starts with `Swarm Bee adapter enabled` and `Swarm Bee adapter started — operations will persist to Swarm` messages

## Current Issue: `Invalid time value` in reactor operations

When mutations are sent through GraphQL, the reactor's `executeRegularAction` throws `Invalid time value`. This happens because:

1. Our forked reactor's `buildModule()` patch changes the variable declarations from `const` to `let` + adds conditional logic
2. The patched JS file was copied from the published npm tarball, which is a minified bundle — our line-level edits may have introduced subtle issues with the bundled code (sourcemap offsets, variable scoping in minified closures)

### Root Cause

The error `Invalid time value` comes from JavaScript's `new Date(invalidString)`. It happens inside the `KyselyOperationStore.apply()` method when it tries to parse a timestamp. The issue is likely that our `buildModule()` patch changed the execution context in a way that affects how the Kysely transaction scoping works with the operation store.

### What Was Tried

1. **Simple `??` replacement**: `const operationStore = this.operationStoreInstance ?? new KyselyOperationStore(database)` — this breaks because the Swarm stores need the Kysely stores as delegates
2. **Always-create + setLocalStore**: Create Kysely stores always, then inject into Swarm stores via `setLocalStore()` — this is correct architecturally but the JS patching of the minified bundle is fragile
3. **`withTransaction` forwarding**: Added to both Swarm stores — this fixed the `withTransaction is not a function` error

### Recommended Next Step

Instead of patching the minified JS bundle, the proper fix is:

1. **Clone the powerhouse repo source**
2. **Apply the 3-line change** to `packages/reactor/src/core/reactor-builder.ts` (the TypeScript source)
3. **Build with `pnpm build`** (uses tsdown, produces correct bundle)
4. **Publish from the built output**

This ensures the bundle is correct and all closures/scoping work properly. The manual JS patching approach is too fragile for production use.

Alternatively, contribute the change upstream to `@powerhousedao/reactor` as a PR — it's a backward-compatible 3-line change that fulfills the documented architecture intent.

## Published Packages

| Package | Version | Status |
|---------|---------|--------|
| `@liberuum-org/reactor` | `6.0.0-dev.156-swarm.1` | Published, but JS patch has the timestamp bug |
| `@liberuum-org/bee-reactor-adapter` | `0.1.0` | Published, works correctly |
| `@liberuum-org/switchboard` | `6.0.0-dev.156-swarm.1` | Published, switchboard patch works |

## Files Changed

### Reactor fork (`packages/reactor/dist/index.js`)
- Added `withOperationStore()` and `withKeyframeStore()` builder methods
- Modified `buildModule()` to always create Kysely stores + optionally wrap with custom stores
- Added `setLocalStore()` callback for injecting Kysely stores into custom wrappers

### Switchboard fork (`packages/switchboard/dist/server-DaWxxH2k.mjs`)  
- Added `import { BeeReactorAdapter }` 
- Creates adapter when `SWARM_BEE_URL`, `SWARM_STAMP_ID`, `SWARM_SIGNER_KEY` env vars are set
- Passes Swarm stores to `builder.withOperationStore()` / `builder.withKeyframeStore()`
- Starts adapter after `buildModule()` for hydration

### Adapter (`bee-reactor-adaptor/src/`)
- Added `withTransaction()` to both `SwarmOperationStore` and `SwarmKeyframeStore`
- Added `setLocalStore()` to both stores for late injection of Kysely delegates
- Added `patchReactorBuilder()` helper (alternative to forking)
