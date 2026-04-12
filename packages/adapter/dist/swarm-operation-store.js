import { createEmptyManifest } from "./types.js";
/**
 * Write-through IOperationStore that persists operations to both a local
 * SQL store (for fast reads) and Swarm /bytes (for decentralized persistence).
 *
 * Writes go to local SQL first (fast, ACID), then upload to Swarm asynchronously.
 * All reads are served from the local SQL cache.
 */
export class SwarmOperationStore {
    swarmClient;
    logger;
    pendingUploads = new Map();
    /** Per-document lock — serializes read-modify-write on the Swarm manifest */
    manifestLocks = new Map();
    localStore;
    constructor(swarmClient, localStore, logger = console) {
        this.swarmClient = swarmClient;
        this.logger = logger;
        this.localStore = localStore;
    }
    /**
     * Replace the local store after construction.
     * Used to inject the Kysely stores created by buildModule() at runtime.
     */
    setLocalStore(store) {
        this.localStore = store;
    }
    /**
     * Forward withTransaction to the local store for Kysely transaction scoping.
     * The returned scoped store still uploads to Swarm via the same client.
     */
    withTransaction(trx) {
        const localStore = this.localStore;
        if (typeof localStore.withTransaction === "function") {
            const scopedLocal = localStore.withTransaction(trx);
            return new SwarmOperationStore(this.swarmClient, scopedLocal, this.logger);
        }
        return this;
    }
    async apply(documentId, documentType, scope, branch, revision, fn, signal) {
        // Write to local SQL first (fast, ACID, optimistic locking)
        await this.localStore.apply(documentId, documentType, scope, branch, revision, fn, signal);
        // Upload to Swarm asynchronously — don't block the reactor write path
        const uploadKey = `${documentId}:${scope}:${branch}:${revision}`;
        const uploadPromise = this.uploadToSwarm(documentId, documentType, scope, branch, revision).catch((err) => {
            this.logger.warn(`Swarm upload failed for ${uploadKey}, will retry on next write:`, err);
        });
        this.pendingUploads.set(uploadKey, uploadPromise);
        uploadPromise.finally(() => this.pendingUploads.delete(uploadKey));
    }
    async getSince(documentId, scope, branch, revision, filter, paging, signal) {
        return this.localStore.getSince(documentId, scope, branch, revision, filter, paging, signal);
    }
    async getSinceId(id, paging, signal) {
        return this.localStore.getSinceId(id, paging, signal);
    }
    async getConflicting(documentId, scope, branch, minTimestamp, paging, signal) {
        return this.localStore.getConflicting(documentId, scope, branch, minTimestamp, paging, signal);
    }
    async getRevisions(documentId, branch, signal) {
        return this.localStore.getRevisions(documentId, branch, signal);
    }
    /**
     * Wait for all pending Swarm uploads to complete.
     * Useful for graceful shutdown.
     */
    async flush() {
        await Promise.allSettled(this.pendingUploads.values());
    }
    /**
     * Upload ops to Swarm and update the document manifest.
     * Serialized per document to prevent lost-update races: two concurrent
     * uploads for the same document would both read the same manifest,
     * both push their batch, and the second write would overwrite the first.
     */
    async uploadToSwarm(documentId, documentType, scope, branch, revision) {
        // Wait for any in-flight manifest write for this document
        const pending = this.manifestLocks.get(documentId);
        if (pending) {
            await pending.catch(() => { });
        }
        const promise = this.doUploadToSwarm(documentId, documentType, scope, branch, revision);
        this.manifestLocks.set(documentId, promise);
        try {
            await promise;
        }
        finally {
            if (this.manifestLocks.get(documentId) === promise) {
                this.manifestLocks.delete(documentId);
            }
        }
    }
    async doUploadToSwarm(documentId, documentType, scope, branch, revision) {
        const ops = await this.localStore.getSince(documentId, scope, branch, revision - 1);
        if (ops.results.length === 0)
            return;
        const payload = JSON.stringify(ops.results);
        const { reference } = await this.swarmClient.uploadData(payload);
        const manifest = (await this.swarmClient.readManifest(documentId)) ??
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
//# sourceMappingURL=swarm-operation-store.js.map