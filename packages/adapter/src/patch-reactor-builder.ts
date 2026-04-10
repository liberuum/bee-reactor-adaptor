/**
 * Patches the published ReactorBuilder to add withOperationStore() and
 * withKeyframeStore() methods. This is needed because the published
 * @powerhousedao/reactor package doesn't have these methods yet.
 *
 * Call this once before using ReactorBuilder:
 *
 *   import { patchReactorBuilder } from "@powerhousedao/bee-reactor-adapter/patch";
 *   import { ReactorBuilder } from "@powerhousedao/reactor";
 *   patchReactorBuilder(ReactorBuilder);
 *
 * Then use normally:
 *   new ReactorBuilder()
 *     .withOperationStore(swarmOps)
 *     .withKeyframeStore(swarmKfs)
 *     .buildModule();
 *
 * Once the upstream reactor package includes these methods natively,
 * this patch can be removed.
 */
export function patchReactorBuilder(ReactorBuilder: any): void {
  const proto = ReactorBuilder.prototype;

  // Skip if already patched (either natively or by us)
  if (typeof proto.withOperationStore === "function") return;

  proto.withOperationStore = function (store: unknown) {
    (this as any).operationStoreInstance = store;
    return this;
  };

  proto.withKeyframeStore = function (store: unknown) {
    (this as any).keyframeStoreInstance = store;
    return this;
  };

  // Patch buildModule to use injected stores
  const originalBuildModule = proto.buildModule;
  proto.buildModule = async function (...args: unknown[]) {
    const module = await originalBuildModule.apply(this, args);

    // If custom stores were provided, we need to rewire them.
    // The published buildModule() always creates KyselyOperationStore/KyselyKeyframeStore.
    // We wrap the module's stores by delegating reads to the original Kysely stores
    // and intercepting writes for Swarm upload.
    //
    // Since the internal components (WriteCache, Executor, etc.) already hold references
    // to the original stores, the Swarm stores must wrap the originals — writes go to
    // both the original (for internal consistency) and Swarm (for persistence).
    // This is exactly what SwarmOperationStore/SwarmKeyframeStore already do.

    const customOpStore = (this as any).operationStoreInstance;
    const customKfStore = (this as any).keyframeStoreInstance;

    if (customOpStore && typeof customOpStore.setLocalStore === "function") {
      customOpStore.setLocalStore(module.operationStore);
    }
    if (customKfStore && typeof customKfStore.setLocalStore === "function") {
      customKfStore.setLocalStore(module.keyframeStore);
    }

    // Replace the module's stores with our wrappers
    if (customOpStore) {
      module.operationStore = customOpStore;
    }
    if (customKfStore) {
      module.keyframeStore = customKfStore;
    }

    return module;
  };
}
