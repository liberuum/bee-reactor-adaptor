/**
 * Write-through IKeyframeStore that persists keyframes to both a local
 * SQL store (for fast reads) and Swarm /bytes (for decentralized persistence).
 */
export class SwarmKeyframeStore {
    swarmClient;
    logger;
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
     */
    withTransaction(trx) {
        const localStore = this.localStore;
        if (typeof localStore.withTransaction === "function") {
            const scopedLocal = localStore.withTransaction(trx);
            return new SwarmKeyframeStore(this.swarmClient, scopedLocal, this.logger);
        }
        return this;
    }
    async putKeyframe(documentId, scope, branch, revision, document, signal) {
        // Write to local SQL first
        await this.localStore.putKeyframe(documentId, scope, branch, revision, document, signal);
        // Upload to Swarm asynchronously
        this.uploadKeyframeToSwarm(documentId, scope, branch, revision, document).catch((err) => {
            this.logger.warn(`Swarm keyframe upload failed for ${documentId}@${revision}:`, err);
        });
    }
    async findNearestKeyframe(documentId, scope, branch, targetRevision, signal) {
        return this.localStore.findNearestKeyframe(documentId, scope, branch, targetRevision, signal);
    }
    async listKeyframes(documentId, scope, branch, signal) {
        return this.localStore.listKeyframes(documentId, scope, branch, signal);
    }
    async deleteKeyframes(documentId, scope, branch, signal) {
        return this.localStore.deleteKeyframes(documentId, scope, branch, signal);
    }
    async uploadKeyframeToSwarm(documentId, scope, branch, revision, document) {
        // Serialize and upload the full keyframe to /bytes
        const payload = JSON.stringify({
            documentId,
            scope,
            branch,
            revision,
            document,
        });
        const { reference } = await this.swarmClient.uploadData(payload);
        // Update the document manifest with the keyframe reference
        const manifest = (await this.swarmClient.readManifest(documentId)) ??
            createEmptyManifest(documentId);
        manifest.keyframes.push({ reference, scope, branch, revision });
        manifest.updatedAt = new Date().toISOString();
        // Compact: remove operation batches older than this keyframe
        // since the keyframe captures the full state at this revision
        manifest.operationBatches = manifest.operationBatches.filter((batch) => batch.scope !== scope ||
            batch.branch !== branch ||
            batch.endIndex > revision);
        await this.swarmClient.updateManifest(documentId, manifest);
    }
}
function createEmptyManifest(documentId) {
    return {
        documentId,
        documentType: "",
        latestRevision: {},
        operationBatches: [],
        keyframes: [],
        updatedAt: new Date().toISOString(),
    };
}
//# sourceMappingURL=swarm-keyframe-store.js.map