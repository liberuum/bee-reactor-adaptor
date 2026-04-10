import type { SwarmClient } from "./swarm-client.js";
import type { SwarmDocumentManifest } from "./types.js";
import type { IOperationStore, DocumentRevisions } from "./swarm-operation-store.js";
import type { IKeyframeStore } from "./swarm-keyframe-store.js";

/**
 * Hydrates a local SQL store from Swarm on startup.
 *
 * Compares local revisions with the Swarm feed manifest and downloads
 * any missing operation batches and keyframes.
 *
 * Decryption is handled by SwarmClient.downloadData() which auto-detects
 * the SWE prefix and decrypts with the client's wallet-derived key.
 * This class does NOT manage its own decryption key.
 */
export class SwarmHydrator {
  private pollingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly swarmClient: SwarmClient,
    private readonly logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void } = console,
  ) {}

  /**
   * Hydrate local stores from Swarm for a list of document IDs.
   *
   * For each document:
   * 1. Read the Swarm feed manifest
   * 2. Compare with local revisions
   * 3. Download missing operation batches
   * 4. Download missing keyframes
   * 5. Insert into local stores
   */
  async hydrate(
    documentIds: string[],
    localOperationStore: IOperationStore,
    localKeyframeStore: IKeyframeStore,
    loadOperations?: (
      documentId: string,
      branch: string,
      operations: unknown[],
    ) => Promise<void>,
  ): Promise<HydrationResult> {
    const result: HydrationResult = {
      documentsHydrated: 0,
      operationBatchesDownloaded: 0,
      keyframesDownloaded: 0,
      errors: [],
    };

    for (const docId of documentIds) {
      try {
        const manifest = await this.swarmClient.readManifest(docId);
        if (!manifest) continue;

        const opsDownloaded = await this.hydrateOperations(
          docId, manifest, localOperationStore, loadOperations,
        );
        const kfsDownloaded = await this.hydrateKeyframes(
          docId, manifest, localKeyframeStore,
        );

        result.operationBatchesDownloaded += opsDownloaded;
        result.keyframesDownloaded += kfsDownloaded;
        if (opsDownloaded > 0 || kfsDownloaded > 0) {
          result.documentsHydrated++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ documentId: docId, error: message });
        this.logger.warn(`Failed to hydrate document ${docId}:`, err);
      }
    }

    this.logger.info(
      `Hydration complete: ${result.documentsHydrated} docs, ` +
        `${result.operationBatchesDownloaded} op batches, ` +
        `${result.keyframesDownloaded} keyframes, ` +
        `${result.errors.length} errors`,
    );

    return result;
  }

  /**
   * Start polling Swarm feeds for updates at a regular interval.
   */
  startPolling(
    documentIds: string[],
    localOperationStore: IOperationStore,
    localKeyframeStore: IKeyframeStore,
    intervalMs: number,
    loadOperations?: (
      documentId: string,
      branch: string,
      operations: unknown[],
    ) => Promise<void>,
  ): void {
    this.stopPolling();
    this.pollingTimer = setInterval(async () => {
      try {
        await this.hydrate(
          documentIds,
          localOperationStore,
          localKeyframeStore,
          loadOperations,
        );
      } catch (err) {
        this.logger.warn("Polling hydration failed:", err);
      }
    }, intervalMs);
  }

  /**
   * Stop polling for feed updates.
   */
  stopPolling(): void {
    if (this.pollingTimer !== null) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /**
   * Download missing operation batches from Swarm and load them locally.
   * Returns the number of batches downloaded.
   */
  private async hydrateOperations(
    documentId: string,
    manifest: SwarmDocumentManifest,
    localOperationStore: IOperationStore,
    loadOperations?: (documentId: string, branch: string, operations: unknown[]) => Promise<void>,
  ): Promise<number> {
    let localRevisions: DocumentRevisions;
    try {
      localRevisions = await localOperationStore.getRevisions(documentId, "main");
    } catch {
      localRevisions = { revision: {}, latestTimestamp: "" };
    }

    let downloaded = 0;
    for (const batch of manifest.operationBatches) {
      const localRev = localRevisions.revision[batch.scope] ?? -1;
      if (batch.endIndex <= localRev) continue;

      try {
        // SwarmClient.downloadData auto-detects and decrypts SWE-prefixed data
        const data = await this.swarmClient.downloadData(batch.reference);
        const operations = JSON.parse(new TextDecoder().decode(data)) as unknown[];

        if (loadOperations) {
          await loadOperations(documentId, batch.branch, operations);
        }

        downloaded++;
      } catch (err) {
        this.logger.warn(
          `Failed to download op batch ${batch.reference} for ${documentId}:`,
          err,
        );
      }
    }
    return downloaded;
  }

  /**
   * Download missing keyframes from Swarm and store them locally.
   * Returns the number of keyframes downloaded.
   */
  private async hydrateKeyframes(
    documentId: string,
    manifest: SwarmDocumentManifest,
    localKeyframeStore: IKeyframeStore,
  ): Promise<number> {
    let downloaded = 0;
    for (const kf of manifest.keyframes) {
      try {
        const existing = await localKeyframeStore.findNearestKeyframe(
          documentId, kf.scope, kf.branch, kf.revision,
        );

        if (existing && existing.revision === kf.revision) continue;

        // SwarmClient.downloadData auto-decrypts
        const data = await this.swarmClient.downloadData(kf.reference);
        const keyframeData = JSON.parse(new TextDecoder().decode(data)) as {
          documentId: string;
          scope: string;
          branch: string;
          revision: number;
          document: Record<string, unknown>;
        };

        await localKeyframeStore.putKeyframe(
          keyframeData.documentId,
          keyframeData.scope,
          keyframeData.branch,
          keyframeData.revision,
          keyframeData.document,
        );

        downloaded++;
      } catch (err) {
        this.logger.warn(
          `Failed to download keyframe ${kf.reference} for ${documentId}:`,
          err,
        );
      }
    }
    return downloaded;
  }
}

export interface HydrationResult {
  documentsHydrated: number;
  operationBatchesDownloaded: number;
  keyframesDownloaded: number;
  errors: Array<{ documentId: string; error: string }>;
}
