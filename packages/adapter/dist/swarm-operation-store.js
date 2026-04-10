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
    localStore;
    constructor(swarmClient, localStore, logger = console) {
        this.swarmClient = swarmClient;
        this.logger = logger;
        this.localStore = localStore;
    }
    /**
     * Replace the local store after construction.
     * Used by patchReactorBuilder to inject the Kysely stores
     * created by buildModule() at runtime.
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
    async uploadToSwarm(documentId, documentType, scope, branch, revision) {
        // Get the operations that were just written
        const ops = await this.localStore.getSince(documentId, scope, branch, revision - 1);
        if (ops.results.length === 0)
            return;
        // Serialize and upload to /bytes
        const payload = JSON.stringify(ops.results);
        const { reference } = await this.swarmClient.uploadData(payload);
        // Read current manifest or create new one
        const manifest = (await this.swarmClient.readManifest(documentId)) ??
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
function createEmptyManifest(documentId, documentType) {
    return {
        documentId,
        documentType,
        latestRevision: {},
        operationBatches: [],
        keyframes: [],
        updatedAt: new Date().toISOString(),
    };
}
//# sourceMappingURL=swarm-operation-store.js.map