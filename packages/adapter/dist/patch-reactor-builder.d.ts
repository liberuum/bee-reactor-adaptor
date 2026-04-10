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
export declare function patchReactorBuilder(ReactorBuilder: any): void;
//# sourceMappingURL=patch-reactor-builder.d.ts.map