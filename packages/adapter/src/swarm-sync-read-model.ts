import type { SwarmClient } from "./swarm-client.js";
import type { SwarmUserManifest } from "./types.js";
import { createEmptyManifest } from "./types.js";
import type { OperationWithContext } from "./swarm-operation-store.js";

/**
 * IReadModel-compatible class that uploads operations to Swarm
 * when they are indexed by the ReadModelCoordinator.
 *
 * This is registered via `ReactorBuilder.withReadModel()` and receives
 * every operation after it's written to the local SQL store. It then:
 * 1. Uploads the operation batch to Swarm /bytes (encrypted by SwarmClient)
 * 2. Updates the per-document manifest
 * 3. Extracts the user's Ethereum address from the signer context
 * 4. Updates the user-level manifest (for document discovery on login)
 *
 * Encryption is handled by SwarmClient (AES-256-GCM when useEncryption is
 * true on the client). This class does NOT manage its own encryption key.
 */
export class SwarmSyncReadModel {
  readonly name = "swarm-sync";
  private pendingUploads: Map<string, Promise<void>> = new Map();

  /** Per-document lock — serializes read-modify-write on the doc manifest feed */
  private docManifestLocks: Map<string, Promise<void>> = new Map();

  /**
   * Per-address write lock for user manifest updates.
   * Prevents lost-update races when multiple documents sync concurrently
   * for the same user (read-modify-write must be serialized).
   */
  private userManifestLocks: Map<string, Promise<void>> = new Map();

  constructor(
    private readonly swarmClient: SwarmClient,
    private readonly logger: {
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
    } = console,
  ) {}

  async indexOperations(operations: OperationWithContext[]): Promise<void> {
    if (operations.length === 0) return;

    // Group operations by documentId
    const byDoc = new Map<string, OperationWithContext[]>();
    for (const op of operations) {
      const docId = op.context.documentId;
      const existing = byDoc.get(docId) ?? [];
      existing.push(op);
      byDoc.set(docId, existing);
    }

    // Upload each document's operations to Swarm (fire-and-forget per doc)
    for (const [docId, ops] of byDoc) {
      const uploadKey = `${docId}:${Date.now()}`;
      const uploadPromise = this.uploadOps(docId, ops).catch((err) => {
        this.logger.warn(
          `Swarm upload failed for ${docId} (${ops.length} ops):`,
          err instanceof Error ? err.message : err,
        );
      });
      this.pendingUploads.set(uploadKey, uploadPromise);
      uploadPromise.finally(() => this.pendingUploads.delete(uploadKey));
    }
  }

  /**
   * Wait for all pending Swarm uploads to complete.
   */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingUploads.values());
  }

  /**
   * Upload ops and update the document manifest.
   * Serialized per document to prevent lost-update races.
   */
  private async uploadOps(
    documentId: string,
    ops: OperationWithContext[],
  ): Promise<void> {
    // Upload to /bytes first (no lock needed — content-addressed, idempotent)
    const jsonPayload = JSON.stringify(
      ops.map((o) => ({
        ...o.operation,
        _context: {
          scope: o.context.scope,
          branch: o.context.branch,
          documentType: o.context.documentType,
          ordinal: o.context.ordinal,
        },
      })),
    );
    const { reference } = await this.swarmClient.uploadData(jsonPayload);

    const scope = ops[0].context.scope;
    const branch = ops[0].context.branch;
    const docType = ops[0].context.documentType;
    const indices = ops.map((o) => o.operation.index);
    const startIndex = Math.min(...indices);
    const endIndex = Math.max(...indices);

    // Serialize the manifest read-modify-write per document
    const pending = this.docManifestLocks.get(documentId);
    if (pending) {
      await pending.catch(() => {});
    }

    const lockPromise = (async () => {
      const manifest =
        (await this.swarmClient.readManifest(documentId)) ??
        createEmptyManifest(documentId, docType);

      manifest.operationBatches.push({
        reference,
        scope,
        branch,
        startIndex,
        endIndex,
        timestamp: new Date().toISOString(),
      });
      manifest.latestRevision[scope] = Math.max(
        manifest.latestRevision[scope] ?? -1,
        endIndex,
      );
      manifest.updatedAt = new Date().toISOString();

      await this.swarmClient.updateManifest(documentId, manifest);
    })();

    this.docManifestLocks.set(documentId, lockPromise);
    try {
      await lockPromise;
    } finally {
      if (this.docManifestLocks.get(documentId) === lockPromise) {
        this.docManifestLocks.delete(documentId);
      }
    }

    // Update user manifest (already serialized per address)
    const userAddress = extractUserAddress(ops);
    if (userAddress) {
      await this.serializedUpdateUserManifest(userAddress, documentId, docType, ops);
    }
  }

  /**
   * Serialize user manifest updates per address to prevent lost-update races.
   *
   * Without this, two concurrent document uploads for the same user would:
   * 1. Both read the same manifest state
   * 2. Both modify it independently
   * 3. The second write overwrites the first's changes
   *
   * The lock ensures read-modify-write is atomic per address.
   */
  private async serializedUpdateUserManifest(
    address: string,
    documentId: string,
    documentType: string,
    ops: OperationWithContext[],
  ): Promise<void> {
    const key = address.toLowerCase();

    // Wait for any in-flight update for this address to complete
    const pending = this.userManifestLocks.get(key);
    if (pending) {
      await pending.catch(() => {});
    }

    const promise = this.updateUserManifest(address, documentId, documentType, ops);
    this.userManifestLocks.set(key, promise);

    try {
      await promise;
    } finally {
      if (this.userManifestLocks.get(key) === promise) {
        this.userManifestLocks.delete(key);
      }
    }
  }

  /**
   * Update the user-level manifest with document info.
   * This allows document discovery by Ethereum address on login.
   */
  private async updateUserManifest(
    address: string,
    documentId: string,
    documentType: string,
    ops: OperationWithContext[],
  ): Promise<void> {
    try {
      const userManifest =
        (await this.swarmClient.readUserManifest(address)) ??
        createEmptyUserManifest(address);

      // Store the Bee node's public key for ACT sharing (once)
      if (!userManifest.beeNodePublicKey) {
        try {
          userManifest.beeNodePublicKey =
            await this.swarmClient.getBeeNodePublicKey();
        } catch {
          // Non-critical — node might not expose /addresses
        }
      }

      // Extract document name from operations (if SET_MODEL_NAME or CREATE_DOCUMENT)
      const name = extractDocumentName(ops) ??
        userManifest.documents[documentId]?.name ??
        documentId;

      // Extract drive ID (document-drive docs have the drive ID as the document ID)
      const driveId = extractDriveId(ops, documentId) ??
        userManifest.documents[documentId]?.driveId ??
        "";

      // Update document entry
      userManifest.documents[documentId] = {
        documentType,
        name,
        driveId,
        lastUpdated: new Date().toISOString(),
      };

      // Update drive entry if we have a drive ID
      if (driveId) {
        const drive = userManifest.drives[driveId] ?? {
          name: driveId,
          documentIds: [],
          lastUpdated: new Date().toISOString(),
        };
        if (!drive.documentIds.includes(documentId)) {
          drive.documentIds.push(documentId);
        }
        drive.lastUpdated = new Date().toISOString();
        userManifest.drives[driveId] = drive;
      }

      userManifest.updatedAt = new Date().toISOString();

      await this.swarmClient.updateUserManifest(address, userManifest);
    } catch (err) {
      this.logger.warn(
        `Failed to update user manifest for ${address}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function createEmptyUserManifest(address: string): SwarmUserManifest {
  return {
    address,
    documents: {},
    drives: {},
    stamps: {},
    updatedAt: new Date().toISOString(),
  };
}

function extractUserAddress(ops: OperationWithContext[]): string | null {
  for (const op of ops) {
    const action = op.operation.action;
    const address = action.context?.signer?.user?.address;
    if (address && address.startsWith("0x") && address.length > 10) {
      return address;
    }
  }
  return null;
}

function extractDocumentName(ops: OperationWithContext[]): string | null {
  for (const op of ops) {
    const action = op.operation.action;
    const input = action.input as Record<string, unknown> | undefined;
    if (action.type === "SET_MODEL_NAME" && input?.name) {
      return input.name as string;
    }
    if (action.type === "CREATE_DOCUMENT" && input?.name) {
      return input.name as string;
    }
  }
  return null;
}

function extractDriveId(
  ops: OperationWithContext[],
  documentId: string,
): string | null {
  for (const op of ops) {
    if (op.context.documentType === "powerhouse/document-drive") {
      return op.context.documentId;
    }
    const action = op.operation.action;
    if (action.type === "ADD_FILE") {
      const input = action.input as Record<string, unknown> | undefined;
      if (input?.id === documentId) {
        return op.context.documentId;
      }
    }
  }
  return null;
}
