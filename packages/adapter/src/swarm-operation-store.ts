import type { SwarmClient } from "./swarm-client.js";
import type { SwarmDocumentManifest } from "./types.js";

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
  apply(
    documentId: string,
    documentType: string,
    scope: string,
    branch: string,
    revision: number,
    fn: (txn: AtomicTxn) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;

  getSince(
    documentId: string,
    scope: string,
    branch: string,
    revision: number,
    filter?: OperationFilter,
    paging?: PagingOptions,
    signal?: AbortSignal,
  ): Promise<PagedResults<Operation>>;

  getSinceId(
    id: number,
    paging?: PagingOptions,
    signal?: AbortSignal,
  ): Promise<PagedResults<OperationWithContext>>;

  getConflicting(
    documentId: string,
    scope: string,
    branch: string,
    minTimestamp: string,
    paging?: PagingOptions,
    signal?: AbortSignal,
  ): Promise<PagedResults<Operation>>;

  getRevisions(
    documentId: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<DocumentRevisions>;
}

/**
 * Write-through IOperationStore that persists operations to both a local
 * SQL store (for fast reads) and Swarm /bytes (for decentralized persistence).
 *
 * Writes go to local SQL first (fast, ACID), then upload to Swarm asynchronously.
 * All reads are served from the local SQL cache.
 */
export class SwarmOperationStore implements IOperationStore {
  private pendingUploads: Map<string, Promise<void>> = new Map();
  private localStore: IOperationStore;

  constructor(
    private readonly swarmClient: SwarmClient,
    localStore: IOperationStore,
    private readonly logger: { warn: (...args: unknown[]) => void } = console,
  ) {
    this.localStore = localStore;
  }

  /**
   * Replace the local store after construction.
   * Used by patchReactorBuilder to inject the Kysely stores
   * created by buildModule() at runtime.
   */
  setLocalStore(store: IOperationStore): void {
    this.localStore = store;
  }

  /**
   * Forward withTransaction to the local store for Kysely transaction scoping.
   * The returned scoped store still uploads to Swarm via the same client.
   */
  withTransaction(trx: unknown): SwarmOperationStore {
    const localStore = this.localStore as any;
    if (typeof localStore.withTransaction === "function") {
      const scopedLocal = localStore.withTransaction(trx);
      return new SwarmOperationStore(this.swarmClient, scopedLocal, this.logger);
    }
    return this;
  }

  async apply(
    documentId: string,
    documentType: string,
    scope: string,
    branch: string,
    revision: number,
    fn: (txn: AtomicTxn) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    // Write to local SQL first (fast, ACID, optimistic locking)
    await this.localStore.apply(
      documentId,
      documentType,
      scope,
      branch,
      revision,
      fn,
      signal,
    );

    // Upload to Swarm asynchronously — don't block the reactor write path
    const uploadKey = `${documentId}:${scope}:${branch}:${revision}`;
    const uploadPromise = this.uploadToSwarm(
      documentId,
      documentType,
      scope,
      branch,
      revision,
    ).catch((err) => {
      this.logger.warn(
        `Swarm upload failed for ${uploadKey}, will retry on next write:`,
        err,
      );
    });

    this.pendingUploads.set(uploadKey, uploadPromise);
    uploadPromise.finally(() => this.pendingUploads.delete(uploadKey));
  }

  async getSince(
    documentId: string,
    scope: string,
    branch: string,
    revision: number,
    filter?: OperationFilter,
    paging?: PagingOptions,
    signal?: AbortSignal,
  ): Promise<PagedResults<Operation>> {
    return this.localStore.getSince(
      documentId,
      scope,
      branch,
      revision,
      filter,
      paging,
      signal,
    );
  }

  async getSinceId(
    id: number,
    paging?: PagingOptions,
    signal?: AbortSignal,
  ): Promise<PagedResults<OperationWithContext>> {
    return this.localStore.getSinceId(id, paging, signal);
  }

  async getConflicting(
    documentId: string,
    scope: string,
    branch: string,
    minTimestamp: string,
    paging?: PagingOptions,
    signal?: AbortSignal,
  ): Promise<PagedResults<Operation>> {
    return this.localStore.getConflicting(
      documentId,
      scope,
      branch,
      minTimestamp,
      paging,
      signal,
    );
  }

  async getRevisions(
    documentId: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<DocumentRevisions> {
    return this.localStore.getRevisions(documentId, branch, signal);
  }

  /**
   * Wait for all pending Swarm uploads to complete.
   * Useful for graceful shutdown.
   */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingUploads.values());
  }

  private async uploadToSwarm(
    documentId: string,
    documentType: string,
    scope: string,
    branch: string,
    revision: number,
  ): Promise<void> {
    // Get the operations that were just written
    const ops = await this.localStore.getSince(
      documentId,
      scope,
      branch,
      revision - 1,
    );

    if (ops.results.length === 0) return;

    // Serialize and upload to /bytes
    const payload = JSON.stringify(ops.results);
    const { reference } = await this.swarmClient.uploadData(payload);

    // Read current manifest or create new one
    const manifest =
      (await this.swarmClient.readManifest(documentId)) ??
      createEmptyManifest(documentId, documentType);

    // Append batch entry
    const endIndex = revision + ops.results.length - 1;
    manifest.operationBatches.push({
      reference,
      scope,
      branch,
      startIndex: revision,
      endIndex,
      timestamp: new Date().toISOString(),
    });
    manifest.latestRevision[scope] = endIndex;
    manifest.updatedAt = new Date().toISOString();

    // Update feed
    await this.swarmClient.updateManifest(documentId, manifest);
  }
}

function createEmptyManifest(
  documentId: string,
  documentType: string,
): SwarmDocumentManifest {
  return {
    documentId,
    documentType,
    latestRevision: {},
    operationBatches: [],
    keyframes: [],
    updatedAt: new Date().toISOString(),
  };
}
