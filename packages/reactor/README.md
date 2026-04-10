# @liberuum-org/reactor

Fork of `@powerhousedao/reactor@6.0.0-dev.156` with custom storage backend injection support.

## What Changed

Two builder methods added to `ReactorBuilder` so that custom `IOperationStore` and `IKeyframeStore` implementations can be injected — fulfilling the documented extension point described in the reactor's [ARCHITECTURE.md](https://github.com/powerhouse-inc/powerhouse/blob/main/packages/reactor/docs/ARCHITECTURE.md#adding-a-storage-backend).

**Total changes: 10 lines added, 2 lines modified.**

## Usage

```bash
# Install as a drop-in replacement for @powerhousedao/reactor
npm install @liberuum-org/reactor@6.0.0-dev.156-swarm.3

# Or override in an existing project
# package.json:
{
  "overrides": {
    "@powerhousedao/reactor": "npm:@liberuum-org/reactor@6.0.0-dev.156-swarm.3"
  }
}
```

```typescript
import { ReactorBuilder } from "@powerhousedao/reactor"; // resolves to our fork

const builder = new ReactorBuilder()
  .withDocumentModels(models)
  .withKysely(kyselyDb)
  .withOperationStore(myCustomOperationStore)  // NEW
  .withKeyframeStore(myCustomKeyframeStore);   // NEW
```

When `withOperationStore()` / `withKeyframeStore()` are not called, behavior is identical to the original package.

## Diff

```diff
--- @powerhousedao/reactor@6.0.0-dev.156
+++ @liberuum-org/reactor@6.0.0-dev.156-swarm.3

 // ReactorBuilder class — new private fields:
+  operationStoreInstance;
+  keyframeStoreInstance;

 // ReactorBuilder class — new methods (after withKysely):
+  withOperationStore(store) {
+    this.operationStoreInstance = store;
+    return this;
+  }
+  withKeyframeStore(store) {
+    this.keyframeStoreInstance = store;
+    return this;
+  }

 // buildModule() — conditional store creation:
-  const operationStore = new KyselyOperationStore(database);
-  const keyframeStore = new KyselyKeyframeStore(database);
+  const operationStore = this.operationStoreInstance ?? new KyselyOperationStore(database);
+  const keyframeStore = this.keyframeStoreInstance ?? new KyselyKeyframeStore(database);
```

## Why Fork?

The reactor's architecture docs list `SwarmOperationStore` and `IPFSOperationStore` as planned implementations with the instruction to "Provide via ReactorBuilder." However, the `withOperationStore()` and `withKeyframeStore()` builder methods were never implemented — only `withKysely()` exists in the published package.

This fork adds those two methods. The change is fully backwards-compatible and intended to be contributed upstream.

## Base Version

- Based on: `@powerhousedao/reactor@6.0.0-dev.156`
- Built from source using `tsdown` (same build toolchain as the original)
- All original functionality preserved
