import { SwarmClient } from "./swarm-client.js";
import { SwarmHydrator } from "./swarm-hydrator.js";
import { SwarmKeyframeStore, } from "./swarm-keyframe-store.js";
import { SwarmOperationStore, } from "./swarm-operation-store.js";
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
export class BeeReactorAdapter {
    swarmClient;
    hydrator;
    config;
    swarmOperationStore = null;
    swarmKeyframeStore = null;
    started = false;
    constructor(config) {
        this.config = {
            ...config,
            trackedDocuments: config.trackedDocuments ?? [],
            pollIntervalMs: config.pollIntervalMs ?? 30_000,
        };
        this.swarmClient = new SwarmClient({
            beeUrl: config.beeUrl,
            batchId: config.batchId,
            signerPrivateKey: config.signerPrivateKey,
            useFeedMode: config.useFeedMode,
        });
        this.hydrator = new SwarmHydrator(this.swarmClient);
    }
    /**
     * Create a SwarmOperationStore wrapping the given local store.
     * Pass the result to ReactorBuilder.withOperationStore().
     */
    createOperationStore(localStore) {
        this.swarmOperationStore = new SwarmOperationStore(this.swarmClient, localStore);
        return this.swarmOperationStore;
    }
    /**
     * Create a SwarmKeyframeStore wrapping the given local store.
     * Pass the result to ReactorBuilder.withKeyframeStore().
     */
    createKeyframeStore(localStore) {
        this.swarmKeyframeStore = new SwarmKeyframeStore(this.swarmClient, localStore);
        return this.swarmKeyframeStore;
    }
    /**
     * Start the adapter after the reactor is built.
     * Hydrates local stores from Swarm and optionally starts polling.
     *
     * @param loadOperations - Optional callback to load operations into the reactor
     *                         (e.g. `(docId, branch, ops) => reactor.load(docId, branch, ops)`)
     */
    async start(loadOperations) {
        if (this.started)
            return;
        this.started = true;
        // Check Bee node health
        const healthy = await this.swarmClient.isHealthy();
        if (!healthy) {
            console.warn(`Bee node at ${this.config.beeUrl} is not reachable. ` +
                `Swarm uploads will fail until the node is available.`);
        }
        // Hydrate local stores from Swarm
        if (this.config.trackedDocuments.length > 0 &&
            this.swarmOperationStore &&
            this.swarmKeyframeStore) {
            await this.hydrator.hydrate(this.config.trackedDocuments, this.swarmOperationStore, this.swarmKeyframeStore, loadOperations);
        }
        // Start polling for updates if configured
        if (this.config.pollIntervalMs > 0 &&
            this.config.trackedDocuments.length > 0 &&
            this.swarmOperationStore &&
            this.swarmKeyframeStore) {
            this.hydrator.startPolling(this.config.trackedDocuments, this.swarmOperationStore, this.swarmKeyframeStore, this.config.pollIntervalMs, loadOperations);
        }
    }
    /**
     * Gracefully stop the adapter.
     * Stops polling and waits for pending uploads to complete.
     */
    async stop() {
        this.hydrator.stopPolling();
        if (this.swarmOperationStore) {
            await this.swarmOperationStore.flush();
        }
        this.started = false;
    }
    /**
     * Get the underlying SwarmClient for direct access.
     */
    getSwarmClient() {
        return this.swarmClient;
    }
    /**
     * Get the owner address derived from the signer key.
     */
    getOwnerAddress() {
        return this.swarmClient.getOwnerAddress();
    }
}
//# sourceMappingURL=bee-reactor-adapter.js.map