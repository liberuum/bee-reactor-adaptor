import { SwarmClient } from "./swarm-client.js";
import { SwarmHydrator } from "./swarm-hydrator.js";
import {
  SwarmKeyframeStore,
  type IKeyframeStore,
} from "./swarm-keyframe-store.js";
import {
  SwarmOperationStore,
  type IOperationStore,
} from "./swarm-operation-store.js";
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
export class BeeReactorAdapter {
  private readonly swarmClient: SwarmClient;
  private readonly hydrator: SwarmHydrator;
  private readonly config: Required<
    Pick<BeeAdapterConfig, "trackedDocuments" | "pollIntervalMs">
  > &
    BeeAdapterConfig;

  private swarmOperationStore: SwarmOperationStore | null = null;
  private swarmKeyframeStore: SwarmKeyframeStore | null = null;
  private started = false;

  constructor(config: BeeAdapterConfig) {
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
  createOperationStore(localStore: IOperationStore): SwarmOperationStore {
    this.swarmOperationStore = new SwarmOperationStore(
      this.swarmClient,
      localStore,
    );
    return this.swarmOperationStore;
  }

  /**
   * Create a SwarmKeyframeStore wrapping the given local store.
   * Pass the result to ReactorBuilder.withKeyframeStore().
   */
  createKeyframeStore(localStore: IKeyframeStore): SwarmKeyframeStore {
    this.swarmKeyframeStore = new SwarmKeyframeStore(
      this.swarmClient,
      localStore,
    );
    return this.swarmKeyframeStore;
  }

  /**
   * Start the adapter after the reactor is built.
   * Hydrates local stores from Swarm and optionally starts polling.
   *
   * @param loadOperations - Optional callback to load operations into the reactor
   *                         (e.g. `(docId, branch, ops) => reactor.load(docId, branch, ops)`)
   */
  async start(
    loadOperations?: (
      documentId: string,
      branch: string,
      operations: unknown[],
    ) => Promise<void>,
  ): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Check Bee node health
    const healthy = await this.swarmClient.isHealthy();
    if (!healthy) {
      console.warn(
        `Bee node at ${this.config.beeUrl} is not reachable. ` +
          `Swarm uploads will fail until the node is available.`,
      );
    }

    // Hydrate local stores from Swarm
    if (
      this.config.trackedDocuments.length > 0 &&
      this.swarmOperationStore &&
      this.swarmKeyframeStore
    ) {
      await this.hydrator.hydrate(
        this.config.trackedDocuments,
        this.swarmOperationStore,
        this.swarmKeyframeStore,
        loadOperations,
      );
    }

    // Start polling for updates if configured
    if (
      this.config.pollIntervalMs > 0 &&
      this.config.trackedDocuments.length > 0 &&
      this.swarmOperationStore &&
      this.swarmKeyframeStore
    ) {
      this.hydrator.startPolling(
        this.config.trackedDocuments,
        this.swarmOperationStore,
        this.swarmKeyframeStore,
        this.config.pollIntervalMs,
        loadOperations,
      );
    }
  }

  /**
   * Gracefully stop the adapter.
   * Stops polling and waits for pending uploads to complete.
   */
  async stop(): Promise<void> {
    this.hydrator.stopPolling();

    if (this.swarmOperationStore) {
      await this.swarmOperationStore.flush();
    }

    this.started = false;
  }

  /**
   * Get the underlying SwarmClient for direct access.
   */
  getSwarmClient(): SwarmClient {
    return this.swarmClient;
  }

  /**
   * Get the owner address derived from the signer key.
   */
  getOwnerAddress(): string {
    return this.swarmClient.getOwnerAddress();
  }
}
