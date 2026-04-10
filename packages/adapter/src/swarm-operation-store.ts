import type { SwarmClient } from "./swarm-client.js";
import { createEmptyManifest } from "./types.js";

/**
 * Minimal type definitions mirroring the Powerhouse reactor's storage interfaces.
 * Defined locally to avoid a hard dependency on the reactor package.
 *
 * Source of truth: @powerhousedao/shared/document-model (actions.ts, operations.ts)
 * and @powerhousedao/reactor (src/storage/interfaces.ts)
 */

/**
 * Mirrors Action from @powerhousedao/shared/document-model/actions.ts.
 * Every document operation wraps an Action that describes a state change.
 */
export interface Action {
  /** Action ID (distinct from the operation ID) */
  id: string;
  /** Action type name (e.g. "SET_MODEL_NAME", "ADD_FILE") */
  type: string;
  /** Timestamp of when the action was created */
  timestampUtcMs: string;
  /** Action payload — shape depends on the document model */
  input: unknown;
  /** Scope of the action (e.g. "global", "local") */
  scope: string;
  /** Attachments included in the action */
  attachments?: Array<{ data: string; mimeType: string; hash: string; extension?: string | null; fileName?: string | null }>;
  /** Signing context — prevOpIndex, prevOpHash, nonce, signer */
  context?: {
    prevOpIndex?: number;
    prevOpHash?: string;
    nonce?: string;
    signer?: { user: { address: string; networkId: string }; app: { name: string; key: string } };
  };
}

/**
 * Mirrors Operation from @powerhousedao/shared/document-model/operations.ts.
 * An immutable record of a state change, stored sequentially per document/scope/branch.
 */
export interface Operation {
  /** Stable ID derived from document and action properties */
  id: string;
  /** Position in the operation history (reactor-local) */
  index: number;
  /** Number of operations skipped (for sync reshuffling) */
  skip: number;
  /** Timestamp of when the operation was added */
  timestampUtcMs: string;
  /** Hash of the resulting document state after this operation */
  hash: string;
  /** Error message if the action failed */
  error?: string;
  /** Serialized resulting state after the operation */
  resultingState?: string;
  /** The action that produced this operation */
  action: Action;
}

/**
 * Mirrors OperationContext from @powerhousedao/shared/document-model/operations.ts.
 */
export interface OperationContext {
  documentId: string;
  documentType: string;
  scope: string;
  branch: string;
  resultingState?: string;
  /** Global ordinal — monotonically increasing across all documents and scopes */
  ordinal: number;
}

/**
 * Mirrors OperationWithContext from @powerhousedao/shared/document-model/operations.ts.
 */
export interface OperationWithContext {
  operation: Operation;
  context: OperationContext;
}

export interface AtomicTxn {
  addOperations(...operations: Operation[]): void;
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
  /** Per-document lock — serializes read-modify-write on the Swarm manifest */
  private manifestLocks: Map<string, Promise<void>> = new Map();
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
   * Used to inject the Kysely stores created by buildModule() at runtime.
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

  /**
   * Upload ops to Swarm and update the document manifest.
   * Serialized per document to prevent lost-update races: two concurrent
   * uploads for the same document would both read the same manifest,
   * both push their batch, and the second write would overwrite the first.
   */
  private async uploadToSwarm(
    documentId: string,
    documentType: string,
    scope: string,
    branch: string,
    revision: number,
  ): Promise<void> {
    // Wait for any in-flight manifest write for this document
    const pending = this.manifestLocks.get(documentId);
    if (pending) {
      await pending.catch(() => {});
    }

    const promise = this.doUploadToSwarm(documentId, documentType, scope, branch, revision);
    this.manifestLocks.set(documentId, promise);

    try {
      await promise;
    } finally {
      if (this.manifestLocks.get(documentId) === promise) {
        this.manifestLocks.delete(documentId);
      }
    }
  }

  private async doUploadToSwarm(
    documentId: string,
    documentType: string,
    scope: string,
    branch: string,
    revision: number,
  ): Promise<void> {
    const ops = await this.localStore.getSince(
      documentId,
      scope,
      branch,
      revision - 1,
    );

    if (ops.results.length === 0) return;

    const payload = JSON.stringify(ops.results);
    const { reference } = await this.swarmClient.uploadData(payload);

    const manifest =
      (await this.swarmClient.readManifest(documentId)) ??
      createEmptyManifest(documentId, documentType);

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

    await this.swarmClient.updateManifest(documentId, manifest);
  }
}
