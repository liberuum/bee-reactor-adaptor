import type { SwarmClient } from "./swarm-client.js";
import type { IOperationStore } from "./swarm-operation-store.js";
import type { IKeyframeStore } from "./swarm-keyframe-store.js";
/**
 * Hydrates a local SQL store from Swarm on startup.
 *
 * Compares local revisions with the Swarm feed manifest and downloads
 * any missing operation batches and keyframes. If data is encrypted
 * (AES-256-GCM with "SWE" prefix), decrypts using the provided key.
 */
export declare class SwarmHydrator {
    private readonly swarmClient;
    private readonly logger;
    private pollingTimer;
    private decryptionKey;
    constructor(swarmClient: SwarmClient, logger?: {
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
    });
    /**
     * Set the decryption key for downloading encrypted content.
     * Must match the key used for encryption (wallet-derived key).
     */
    setDecryptionKey(key: string | null): void;
    /**
     * Hydrate local stores from Swarm for a list of document IDs.
     *
     * For each document:
     * 1. Read the Swarm feed manifest
     * 2. Compare with local revisions
     * 3. Download missing operation batches
     * 4. Download missing keyframes
     * 5. Insert into local stores
     *
     * @param documentIds - Documents to hydrate
     * @param localOperationStore - The underlying local SQL operation store
     * @param localKeyframeStore - The underlying local SQL keyframe store
     * @param loadOperations - Callback to load operations into the reactor (e.g. reactor.load)
     */
    hydrate(documentIds: string[], localOperationStore: IOperationStore, localKeyframeStore: IKeyframeStore, loadOperations?: (documentId: string, branch: string, operations: unknown[]) => Promise<void>): Promise<HydrationResult>;
    /**
     * Start polling Swarm feeds for updates at a regular interval.
     */
    startPolling(documentIds: string[], localOperationStore: IOperationStore, localKeyframeStore: IKeyframeStore, intervalMs: number, loadOperations?: (documentId: string, branch: string, operations: unknown[]) => Promise<void>): void;
    /**
     * Stop polling for feed updates.
     */
    stopPolling(): void;
    private hydrateDocument;
}
export interface HydrationResult {
    documentsHydrated: number;
    operationBatchesDownloaded: number;
    keyframesDownloaded: number;
    errors: Array<{
        documentId: string;
        error: string;
    }>;
}
//# sourceMappingURL=swarm-hydrator.d.ts.map