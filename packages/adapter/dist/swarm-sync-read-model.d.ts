import type { SwarmClient } from "./swarm-client.js";
/**
 * IReadModel-compatible class that uploads operations to Swarm
 * when they are indexed by the ReadModelCoordinator.
 *
 * This is registered via `ReactorBuilder.withReadModel()` and receives
 * every operation after it's written to the local SQL store. It then:
 * 1. Uploads the operation batch to Swarm /bytes (optionally encrypted)
 * 2. Updates the per-document manifest
 * 3. Extracts the user's Ethereum address from the signer context
 * 4. Updates the user-level manifest (for document discovery on login)
 *
 * When an encryption key is set (via `setEncryptionKey()`), all operation
 * payloads and manifests are encrypted with AES-256-GCM before upload.
 * The key is typically derived from the user's wallet signature.
 */
export declare class SwarmSyncReadModel {
    private readonly swarmClient;
    private readonly logger;
    readonly name = "swarm-sync";
    private pendingUploads;
    private encryptionKey;
    constructor(swarmClient: SwarmClient, logger?: {
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
    });
    /**
     * Set the encryption key for all future uploads.
     * When set, operation batches are AES-256-GCM encrypted before upload.
     * Pass null to disable encryption.
     */
    setEncryptionKey(key: string | null): void;
    /**
     * Whether encryption is currently active.
     */
    isEncryptionEnabled(): boolean;
    indexOperations(operations: OperationWithContext[]): Promise<void>;
    /**
     * Wait for all pending Swarm uploads to complete.
     */
    flush(): Promise<void>;
    private uploadOps;
    /**
     * Update the user-level manifest with document info.
     * This allows document discovery by Ethereum address on login.
     */
    private updateUserManifest;
}
/**
 * Minimal type matching reactor's OperationWithContext.
 */
interface OperationWithContext {
    operation: {
        id: string;
        index: number;
        skip: number;
        timestampUtcMs: string;
        hash: string;
        error?: string;
        action: unknown;
        [key: string]: unknown;
    };
    context: {
        documentId: string;
        documentType: string;
        scope: string;
        branch: string;
        resultingState?: string;
        ordinal: number;
    };
}
export {};
//# sourceMappingURL=swarm-sync-read-model.d.ts.map