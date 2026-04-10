import type { SwarmClient } from "./swarm-client.js";
import type { SwarmDocumentManifest } from "./types.js";

/**
 * Minimal PHDocument type matching the reactor's definition.
 * The actual type from the reactor should be used when integrating.
 */
export type PHDocument = Record<string, unknown>;

export interface IKeyframeStore {
  putKeyframe(
    documentId: string,
    scope: string,
    branch: string,
    revision: number,
    document: PHDocument,
    signal?: AbortSignal,
  ): Promise<void>;

  findNearestKeyframe(
    documentId: string,
    scope: string,
    branch: string,
    targetRevision: number,
    signal?: AbortSignal,
  ): Promise<{ revision: number; document: PHDocument } | undefined>;

  listKeyframes(
    documentId: string,
    scope?: string,
    branch?: string,
    signal?: AbortSignal,
  ): Promise<
    Array<{
      scope: string;
      branch: string;
      revision: number;
      document: PHDocument;
    }>
  >;

  deleteKeyframes(
    documentId: string,
    scope?: string,
    branch?: string,
    signal?: AbortSignal,
  ): Promise<number>;
}

/**
 * Write-through IKeyframeStore that persists keyframes to both a local
 * SQL store (for fast reads) and Swarm /bytes (for decentralized persistence).
 */
export class SwarmKeyframeStore implements IKeyframeStore {
  private localStore: IKeyframeStore;

  constructor(
    private readonly swarmClient: SwarmClient,
    localStore: IKeyframeStore,
    private readonly logger: { warn: (...args: unknown[]) => void } = console,
  ) {
    this.localStore = localStore;
  }

  /**
   * Replace the local store after construction.
   * Used by patchReactorBuilder to inject the Kysely stores
   * created by buildModule() at runtime.
   */
  setLocalStore(store: IKeyframeStore): void {
    this.localStore = store;
  }

  /**
   * Forward withTransaction to the local store for Kysely transaction scoping.
   */
  withTransaction(trx: unknown): SwarmKeyframeStore {
    const localStore = this.localStore as any;
    if (typeof localStore.withTransaction === "function") {
      const scopedLocal = localStore.withTransaction(trx);
      return new SwarmKeyframeStore(this.swarmClient, scopedLocal, this.logger);
    }
    return this;
  }

  async putKeyframe(
    documentId: string,
    scope: string,
    branch: string,
    revision: number,
    document: PHDocument,
    signal?: AbortSignal,
  ): Promise<void> {
    // Write to local SQL first
    await this.localStore.putKeyframe(
      documentId,
      scope,
      branch,
      revision,
      document,
      signal,
    );

    // Upload to Swarm asynchronously
    this.uploadKeyframeToSwarm(
      documentId,
      scope,
      branch,
      revision,
      document,
    ).catch((err) => {
      this.logger.warn(
        `Swarm keyframe upload failed for ${documentId}@${revision}:`,
        err,
      );
    });
  }

  async findNearestKeyframe(
    documentId: string,
    scope: string,
    branch: string,
    targetRevision: number,
    signal?: AbortSignal,
  ): Promise<{ revision: number; document: PHDocument } | undefined> {
    return this.localStore.findNearestKeyframe(
      documentId,
      scope,
      branch,
      targetRevision,
      signal,
    );
  }

  async listKeyframes(
    documentId: string,
    scope?: string,
    branch?: string,
    signal?: AbortSignal,
  ): Promise<
    Array<{
      scope: string;
      branch: string;
      revision: number;
      document: PHDocument;
    }>
  > {
    return this.localStore.listKeyframes(documentId, scope, branch, signal);
  }

  async deleteKeyframes(
    documentId: string,
    scope?: string,
    branch?: string,
    signal?: AbortSignal,
  ): Promise<number> {
    return this.localStore.deleteKeyframes(documentId, scope, branch, signal);
  }

  private async uploadKeyframeToSwarm(
    documentId: string,
    scope: string,
    branch: string,
    revision: number,
    document: PHDocument,
  ): Promise<void> {
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
    const manifest =
      (await this.swarmClient.readManifest(documentId)) ??
      createEmptyManifest(documentId);

    manifest.keyframes.push({ reference, scope, branch, revision });
    manifest.updatedAt = new Date().toISOString();

    // Compact: remove operation batches older than this keyframe
    // since the keyframe captures the full state at this revision
    manifest.operationBatches = manifest.operationBatches.filter(
      (batch) =>
        batch.scope !== scope ||
        batch.branch !== branch ||
        batch.endIndex > revision,
    );

    await this.swarmClient.updateManifest(documentId, manifest);
  }
}

function createEmptyManifest(documentId: string): SwarmDocumentManifest {
  return {
    documentId,
    documentType: "",
    latestRevision: {},
    operationBatches: [],
    keyframes: [],
    updatedAt: new Date().toISOString(),
  };
}
