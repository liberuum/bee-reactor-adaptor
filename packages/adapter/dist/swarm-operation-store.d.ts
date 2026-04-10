import type { SwarmClient } from "./swarm-client.js";
/**
 * Minimal type definitions matching the reactor's IOperationStore interface.
 * These are defined locally to avoid a hard dependency on the reactor package.
 * When integrating, the actual reactor types should be used.
 */
export interface AtomicTxn {
    addOperations(...operations: Operation[]): void;
}
export interface Operation {
    id: string;
    index: number;
    skip: number;
    timestampUtcMs: string;
    hash: string;
    error?: string;
    resultingState?: string;
    action: unknown;
}
export interface OperationWithContext {
    operation: Operation;
    context: {
        documentId: string;
        documentType: string;
        scope: string;
        branch: string;
        resultingState?: string;
        ordinal: number;
    };
}
export interface OperationFilter {
    actionTypes?: string[];
    timestampFrom?: string;
    timestampTo?: string;
    sinceRevision?: number;
}
export interface PagingOptions {
    cursor?: string;
    limit?: number;
}
export interface PagedResults<T> {
    results: T[];
    nextCursor?: string;
    next?: () => Promise<PagedResults<T>>;
}
export interface DocumentRevisions {
    revision: Record<string, number>;
    latestTimestamp: string;
}
export interface IOperationStore {
    apply(documentId: string, documentType: string, scope: string, branch: string, revision: number, fn: (txn: AtomicTxn) => void | Promise<void>, signal?: AbortSignal): Promise<void>;
    getSince(documentId: string, scope: string, branch: string, revision: number, filter?: OperationFilter, paging?: PagingOptions, signal?: AbortSignal): Promise<PagedResults<Operation>>;
    getSinceId(id: number, paging?: PagingOptions, signal?: AbortSignal): Promise<PagedResults<OperationWithContext>>;
    getConflicting(documentId: string, scope: string, branch: string, minTimestamp: string, paging?: PagingOptions, signal?: AbortSignal): Promise<PagedResults<Operation>>;
    getRevisions(documentId: string, branch: string, signal?: AbortSignal): Promise<DocumentRevisions>;
}
/**
 * Write-through IOperationStore that persists operations to both a local
 * SQL store (for fast reads) and Swarm /bytes (for decentralized persistence).
 *
 * Writes go to local SQL first (fast, ACID), then upload to Swarm asynchronously.
 * All reads are served from the local SQL cache.
 */
export declare class SwarmOperationStore implements IOperationStore {
    private readonly swarmClient;
    private readonly logger;
    private pendingUploads;
    private localStore;
    constructor(swarmClient: SwarmClient, localStore: IOperationStore, logger?: {
        warn: (...args: unknown[]) => void;
    });
    /**
     * Replace the local store after construction.
     * Used by patchReactorBuilder to inject the Kysely stores
     * created by buildModule() at runtime.
     */
    setLocalStore(store: IOperationStore): void;
    /**
     * Forward withTransaction to the local store for Kysely transaction scoping.
     * The returned scoped store still uploads to Swarm via the same client.
     */
    withTransaction(trx: unknown): SwarmOperationStore;
    apply(documentId: string, documentType: string, scope: string, branch: string, revision: number, fn: (txn: AtomicTxn) => void | Promise<void>, signal?: AbortSignal): Promise<void>;
    getSince(documentId: string, scope: string, branch: string, revision: number, filter?: OperationFilter, paging?: PagingOptions, signal?: AbortSignal): Promise<PagedResults<Operation>>;
    getSinceId(id: number, paging?: PagingOptions, signal?: AbortSignal): Promise<PagedResults<OperationWithContext>>;
    getConflicting(documentId: string, scope: string, branch: string, minTimestamp: string, paging?: PagingOptions, signal?: AbortSignal): Promise<PagedResults<Operation>>;
    getRevisions(documentId: string, branch: string, signal?: AbortSignal): Promise<DocumentRevisions>;
    /**
     * Wait for all pending Swarm uploads to complete.
     * Useful for graceful shutdown.
     */
    flush(): Promise<void>;
    private uploadToSwarm;
}
//# sourceMappingURL=swarm-operation-store.d.ts.map