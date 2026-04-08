import { SwarmClient } from "./swarm-client.js";
import { SwarmKeyframeStore, type IKeyframeStore } from "./swarm-keyframe-store.js";
import { SwarmOperationStore, type IOperationStore } from "./swarm-operation-store.js";
import type { BeeAdapterConfig } from "./types.js";
/**
 * Main entry point for the Swarm Bee reactor storage adapter.
 *
 * Usage:
 * ```typescript
 * const adapter = new BeeReactorAdapter({
 *   beeUrl: 'http://localhost:1633',
 *   batchId: 'abc123...',
 *   signerPrivateKey: '0x...',
 *   trackedDocuments: ['doc-1', 'doc-2'],
 * });
 *
 * const operationStore = adapter.createOperationStore(localOperationStore);
 * const keyframeStore = adapter.createKeyframeStore(localKeyframeStore);
 *
 * // Pass to ReactorBuilder:
 * builder
 *   .withOperationStore(operationStore)
 *   .withKeyframeStore(keyframeStore);
 *
 * const module = await builder.buildModule();
 * await adapter.start(module.operationStore, module.keyframeStore);
 * ```
 */
export declare class BeeReactorAdapter {
    private readonly swarmClient;
    private readonly hydrator;
    private readonly config;
    private swarmOperationStore;
    private swarmKeyframeStore;
    private started;
    constructor(config: BeeAdapterConfig);
    /**
     * Create a SwarmOperationStore wrapping the given local store.
     * Pass the result to ReactorBuilder.withOperationStore().
     */
    createOperationStore(localStore: IOperationStore): SwarmOperationStore;
    /**
     * Create a SwarmKeyframeStore wrapping the given local store.
     * Pass the result to ReactorBuilder.withKeyframeStore().
     */
    createKeyframeStore(localStore: IKeyframeStore): SwarmKeyframeStore;
    /**
     * Start the adapter after the reactor is built.
     * Hydrates local stores from Swarm and optionally starts polling.
     *
     * @param loadOperations - Optional callback to load operations into the reactor
     *                         (e.g. `(docId, branch, ops) => reactor.load(docId, branch, ops)`)
     */
    start(loadOperations?: (documentId: string, branch: string, operations: unknown[]) => Promise<void>): Promise<void>;
    /**
     * Gracefully stop the adapter.
     * Stops polling and waits for pending uploads to complete.
     */
    stop(): Promise<void>;
    /**
     * Get the underlying SwarmClient for direct access.
     */
    getSwarmClient(): SwarmClient;
    /**
     * Get the owner address derived from the signer key.
     */
    getOwnerAddress(): string;
}
//# sourceMappingURL=bee-reactor-adapter.d.ts.map