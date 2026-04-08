import { isEncrypted, decrypt } from "./swarm-crypto.js";
/**
 * Hydrates a local SQL store from Swarm on startup.
 *
 * Compares local revisions with the Swarm feed manifest and downloads
 * any missing operation batches and keyframes. If data is encrypted
 * (AES-256-GCM with "SWE" prefix), decrypts using the provided key.
 */
export class SwarmHydrator {
    swarmClient;
    logger;
    pollingTimer = null;
    decryptionKey = null;
    constructor(swarmClient, logger = console) {
        this.swarmClient = swarmClient;
        this.logger = logger;
    }
    /**
     * Set the decryption key for downloading encrypted content.
     * Must match the key used for encryption (wallet-derived key).
     */
    setDecryptionKey(key) {
        this.decryptionKey = key;
    }
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
    async hydrate(documentIds, localOperationStore, localKeyframeStore, loadOperations) {
        const result = {
            documentsHydrated: 0,
            operationBatchesDownloaded: 0,
            keyframesDownloaded: 0,
            errors: [],
        };
        for (const docId of documentIds) {
            try {
                await this.hydrateDocument(docId, localOperationStore, localKeyframeStore, loadOperations, result);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                result.errors.push({ documentId: docId, error: message });
                this.logger.warn(`Failed to hydrate document ${docId}:`, err);
            }
        }
        this.logger.info(`Hydration complete: ${result.documentsHydrated} docs, ` +
            `${result.operationBatchesDownloaded} op batches, ` +
            `${result.keyframesDownloaded} keyframes, ` +
            `${result.errors.length} errors`);
        return result;
    }
    /**
     * Start polling Swarm feeds for updates at a regular interval.
     */
    startPolling(documentIds, localOperationStore, localKeyframeStore, intervalMs, loadOperations) {
        this.stopPolling();
        this.pollingTimer = setInterval(async () => {
            try {
                await this.hydrate(documentIds, localOperationStore, localKeyframeStore, loadOperations);
            }
            catch (err) {
                this.logger.warn("Polling hydration failed:", err);
            }
        }, intervalMs);
    }
    /**
     * Stop polling for feed updates.
     */
    stopPolling() {
        if (this.pollingTimer !== null) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = null;
        }
    }
    async hydrateDocument(documentId, localOperationStore, localKeyframeStore, loadOperations, result) {
        const manifest = await this.swarmClient.readManifest(documentId);
        if (!manifest)
            return;
        let hydrated = false;
        // Get local revisions for comparison
        let localRevisions;
        try {
            localRevisions = await localOperationStore.getRevisions(documentId, "main");
        }
        catch {
            // If document doesn't exist locally yet, start from scratch
            localRevisions = { revision: {}, latestTimestamp: "" };
        }
        // Download missing operation batches
        for (const batch of manifest.operationBatches) {
            const localRev = localRevisions.revision[batch.scope] ?? -1;
            if (batch.endIndex > localRev) {
                try {
                    let data = await this.swarmClient.downloadData(batch.reference);
                    // Auto-detect and decrypt if encrypted
                    if (isEncrypted(data)) {
                        if (!this.decryptionKey) {
                            this.logger.warn(`Encrypted data found for ${documentId} but no decryption key set`);
                            continue;
                        }
                        data = await decrypt(data, this.decryptionKey);
                    }
                    const operations = JSON.parse(new TextDecoder().decode(data));
                    if (loadOperations) {
                        await loadOperations(documentId, batch.branch, operations);
                    }
                    result.operationBatchesDownloaded++;
                    hydrated = true;
                }
                catch (err) {
                    this.logger.warn(`Failed to download op batch ${batch.reference} for ${documentId}:`, err);
                }
            }
        }
        // Download missing keyframes
        for (const kf of manifest.keyframes) {
            try {
                const existing = await localKeyframeStore.findNearestKeyframe(documentId, kf.scope, kf.branch, kf.revision);
                // Only download if we don't have this exact keyframe
                if (!existing || existing.revision !== kf.revision) {
                    const data = await this.swarmClient.downloadData(kf.reference);
                    const keyframeData = JSON.parse(new TextDecoder().decode(data));
                    await localKeyframeStore.putKeyframe(keyframeData.documentId, keyframeData.scope, keyframeData.branch, keyframeData.revision, keyframeData.document);
                    result.keyframesDownloaded++;
                    hydrated = true;
                }
            }
            catch (err) {
                this.logger.warn(`Failed to download keyframe ${kf.reference} for ${documentId}:`, err);
            }
        }
        if (hydrated) {
            result.documentsHydrated++;
        }
    }
}
//# sourceMappingURL=swarm-hydrator.js.map