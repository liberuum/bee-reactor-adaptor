import type { SwarmClient } from "./swarm-client.js";
import { encrypt } from "./swarm-crypto.js";
import type {
  SwarmDocumentManifest,
  SwarmUserManifest,
} from "./types.js";

/**
 * IReadModel-compatible class that uploads operations to Swarm
 * when they are indexed by the ReadModelCoordinator.
 *
 * This is registered via `ReactorBuilder.withReadModel()` and receives
 * every operation after it's written to the local SQL store. It then:
 * 1. Uploads the operation batch to Swarm /bytes (optionally encrypted)
 * 2. Updates the per-document manifest
 * 3. Extracts the user's Ethereum address from the signer context
 * 4. Updates the user-level manifest (for document discovery on login)
 *
 * When an encryption key is set (via `setEncryptionKey()`), all operation
 * payloads and manifests are encrypted with AES-256-GCM before upload.
 * The key is typically derived from the user's wallet signature.
 */
export class SwarmSyncReadModel {
  readonly name = "swarm-sync";
  private pendingUploads: Map<string, Promise<void>> = new Map();
  private encryptionKey: string | null = null;

  constructor(
    private readonly swarmClient: SwarmClient,
    private readonly logger: {
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
    } = console,
  ) {}

  /**
   * Set the encryption key for all future uploads.
   * When set, operation batches are AES-256-GCM encrypted before upload.
   * Pass null to disable encryption.
   */
  setEncryptionKey(key: string | null): void {
    this.encryptionKey = key;
    if (key) {
      this.logger.info("[SwarmSync] Encryption enabled for uploads");
    }
  }

  /**
   * Whether encryption is currently active.
   */
  isEncryptionEnabled(): boolean {
    return this.encryptionKey !== null;
  }

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

  private async uploadOps(
    documentId: string,
    ops: OperationWithContext[],
  ): Promise<void> {
    // Serialize operations
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

    // Encrypt if key is available, otherwise upload plaintext
    let uploadData: string | Uint8Array = jsonPayload;
    const encrypted = this.encryptionKey !== null;
    if (encrypted) {
      uploadData = await encrypt(jsonPayload, this.encryptionKey!);
    }

    // Upload to Swarm /bytes
    const { reference } = await this.swarmClient.uploadData(uploadData);

    // Determine scope/branch from first op (they're grouped by doc)
    const scope = ops[0].context.scope;
    const branch = ops[0].context.branch;
    const docType = ops[0].context.documentType;
    const indices = ops.map((o) => o.operation.index);
    const startIndex = Math.min(...indices);
    const endIndex = Math.max(...indices);

    // Update document manifest
    const manifest =
      (await this.swarmClient.readManifest(documentId)) ??
      createEmptyDocManifest(documentId, docType);

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
    manifest.encrypted = encrypted;
    manifest.updatedAt = new Date().toISOString();

    await this.swarmClient.updateManifest(documentId, manifest);

    // Extract user address from signer context and update user manifest
    const userAddress = extractUserAddress(ops);
    if (userAddress) {
      await this.updateUserManifest(userAddress, documentId, docType, ops);
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

// ─── Helpers ─────────────────────────────────────────────────────

function createEmptyDocManifest(
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

function createEmptyUserManifest(address: string): SwarmUserManifest {
  return {
    address,
    documents: {},
    drives: {},
    stamps: {},
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Extract the user's Ethereum address from the signer context in operations.
 */
function extractUserAddress(ops: OperationWithContext[]): string | null {
  for (const op of ops) {
    const action = op.operation.action as Record<string, unknown> | undefined;
    const context = action?.context as Record<string, unknown> | undefined;
    const signer = context?.signer as Record<string, unknown> | undefined;
    const user = signer?.user as Record<string, unknown> | undefined;
    const address = user?.address as string | undefined;
    if (address && address.startsWith("0x") && address.length > 10) {
      return address;
    }
  }
  return null;
}

/**
 * Try to extract a document name from operations.
 */
function extractDocumentName(ops: OperationWithContext[]): string | null {
  for (const op of ops) {
    const action = op.operation.action as Record<string, unknown> | undefined;
    if (!action) continue;
    const actionType = action.type as string | undefined;
    const input = action.input as Record<string, unknown> | undefined;
    if (actionType === "SET_MODEL_NAME" && input?.name) {
      return input.name as string;
    }
    if (actionType === "CREATE_DOCUMENT" && input?.name) {
      return input.name as string;
    }
  }
  return null;
}

/**
 * Try to extract the drive ID this document belongs to.
 */
function extractDriveId(
  ops: OperationWithContext[],
  documentId: string,
): string | null {
  for (const op of ops) {
    const action = op.operation.action as Record<string, unknown> | undefined;
    const actionType = action?.type as string | undefined;
    if (op.context.documentType === "powerhouse/document-drive") {
      return op.context.documentId;
    }
    if (actionType === "ADD_FILE") {
      const input = action?.input as Record<string, unknown> | undefined;
      if (input?.id === documentId) {
        return op.context.documentId;
      }
    }
  }
  return null;
}

/**
 * Minimal type matching reactor's OperationWithContext.
 */
interface OperationWithContext {
  operation: {
    id: string;
    index: number;
    skip: number;
    timestampUtcMs: string;
    hash: string;
    error?: string;
    action: unknown;
    [key: string]: unknown;
  };
  context: {
    documentId: string;
    documentType: string;
    scope: string;
    branch: string;
    resultingState?: string;
    ordinal: number;
  };
}
