/**
 * SwarmChannel — IChannel implementation for Swarm decentralized sync.
 *
 * Push cycle (outbox): local operations → encrypt → upload /bytes → write feed
 * Pull cycle (inbox):  read feed → download /bytes → decrypt → add to inbox
 *
 * Uses the reactor's built-in SyncManager for orchestration, cursor tracking,
 * and dead letter handling. This channel only implements the transport layer.
 */
import type { ILogger } from "document-model";
import type {
  IOperationIndex,
  ISyncCursorStorage,
  ConnectionStateChangeCallback,
  IChannel,
  ConnectionState,
  ConnectionStateSnapshot,
  RemoteFilter,
} from "@powerhousedao/reactor";
import {
  Mailbox,
  SyncOperation,
  ChannelError,
  ChannelErrorSource,
} from "@powerhousedao/reactor";
import type { SwarmClient } from "../swarm-client.js";

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

export type SwarmChannelConfig = {
  /** Bee node API URL */
  beeUrl: string;
  /** Postage batch ID for uploads */
  batchId: string;
  /** Feed topic prefix for namespacing */
  feedTopicPrefix: string;
  /** Owner's Ethereum address (hex) */
  ownerAddress: string;
  /** Poll interval for inbox pull cycle (ms) */
  pollIntervalMs: number;
  /** Collection ID being synced */
  collectionId: string;
  /** Operation filter */
  filter: RemoteFilter;
};

// ═══════════════════════════════════════════════════════════════
// Health Check Constants
// ═══════════════════════════════════════════════════════════════

const HEALTH_CHECK_TIMEOUT_MS = 3000;
const HEALTH_CHECK_INTERVAL_MS = 15000;
const MAX_PUSH_RETRIES = 3;

// ═══════════════════════════════════════════════════════════════
// SwarmChannel
// ═══════════════════════════════════════════════════════════════

export class SwarmChannel implements IChannel {
  readonly inbox: IMailbox;
  readonly outbox: IMailbox;
  readonly deadLetter: IMailbox;

  private readonly channelId: string;
  private readonly remoteName: string;
  private readonly cursorStorage: ISyncCursorStorage;
  private readonly operationIndex: IOperationIndex;
  private readonly config: SwarmChannelConfig;
  private readonly logger: ILogger;

  // Connection state
  private connectionState: ConnectionState = "connecting";
  private readonly connectionStateCallbacks = new Set<ConnectionStateChangeCallback>();
  private failureCount = 0;
  private lastSuccessUtcMs = 0;
  private lastFailureUtcMs = 0;
  private pushFailureCount = 0;
  private pushBlocked = false;

  // Lifecycle
  private isShutdown = false;
  private readonly abortController = new AbortController();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  // Cursor persistence tracking
  private lastPersistedInboxOrdinal = 0;
  private lastPersistedOutboxOrdinal = 0;

  // SwarmClient — set during init() after wallet key derivation
  private swarmClient: SwarmClient | null = null;

  constructor(
    logger: ILogger,
    channelId: string,
    remoteName: string,
    cursorStorage: ISyncCursorStorage,
    config: SwarmChannelConfig,
    operationIndex: IOperationIndex,
  ) {
    this.logger = logger;
    this.channelId = channelId;
    this.remoteName = remoteName;
    this.cursorStorage = cursorStorage;
    this.operationIndex = operationIndex;
    this.config = config;

    // Create mailboxes
    this.outbox = new Mailbox();
    this.inbox = new Mailbox();
    this.deadLetter = new Mailbox();

    // Register outbox push handler
    this.outbox.onAdded((syncOps: SyncOperation[]) => {
      this.handleOutboxAdded(syncOps).catch((err) => {
        this.logger.error("[SwarmChannel] Outbox handler error:", err);
      });
    });

    // Persist inbox cursor when items are removed (processed by SyncManager)
    this.inbox.onRemoved(() => {
      this.persistInboxCursor().catch(() => {});
    });

    // Persist outbox cursor when items are removed (acknowledged)
    this.outbox.onRemoved(() => {
      this.persistOutboxCursor().catch(() => {});
    });
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  async init(): Promise<void> {
    this.logger.info(`[SwarmChannel] Initializing for remote "${this.remoteName}"`);

    // Load persisted cursors
    const inboxCursor = await this.cursorStorage.get(this.remoteName, "inbox");
    const outboxCursor = await this.cursorStorage.get(this.remoteName, "outbox");

    this.inbox.init(inboxCursor?.cursorOrdinal ?? 0);
    this.outbox.init(outboxCursor?.cursorOrdinal ?? 0);
    this.lastPersistedInboxOrdinal = inboxCursor?.cursorOrdinal ?? 0;
    this.lastPersistedOutboxOrdinal = outboxCursor?.cursorOrdinal ?? 0;

    this.logger.info(
      `[SwarmChannel] Cursors loaded — inbox: ${this.inbox.ackOrdinal}, outbox: ${this.outbox.ackOrdinal}`,
    );

    // Resolve SwarmClient from window.ph.swarm (set by existing plugin init)
    this.resolveSwarmClient();

    // Check Bee node health
    const healthy = await this.checkBeeHealth();
    if (healthy) {
      this.setConnectionState("connected");
    } else {
      this.setConnectionState("reconnecting");
    }

    // Start health check timer
    this.healthTimer = setInterval(() => {
      this.checkBeeHealth().then((ok) => {
        if (ok && this.connectionState !== "connected") {
          this.setConnectionState("connected");
        } else if (!ok && this.connectionState === "connected") {
          this.setConnectionState("reconnecting");
        }
      }).catch(() => {});
    }, HEALTH_CHECK_INTERVAL_MS);

    // Inbox poll timer — disabled by default.
    // The old plugin's hydration handles recovery for now.
    // Enable once SwarmChannel fully replaces the plugin:
    //
    // this.pollTimer = setInterval(() => {
    //   if (this.connectionState === "connected") {
    //     this.pollInbox().catch((err) => {
    //       this.logger.warn("[SwarmChannel] Poll error:", err instanceof Error ? err.message : err);
    //     });
    //   }
    // }, this.config.pollIntervalMs);
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    this.abortController.abort();

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    // Persist final cursor positions
    await this.persistInboxCursor();
    await this.persistOutboxCursor();

    this.setConnectionState("disconnected");
    this.logger.info(`[SwarmChannel] Shut down for remote "${this.remoteName}"`);
  }

  // ─── Connection State ─────────────────────────────────────────

  getConnectionState(): ConnectionStateSnapshot {
    return {
      state: this.connectionState,
      failureCount: this.failureCount,
      lastSuccessUtcMs: this.lastSuccessUtcMs,
      lastFailureUtcMs: this.lastFailureUtcMs,
      pushBlocked: this.pushBlocked,
      pushFailureCount: this.pushFailureCount,
    };
  }

  onConnectionStateChange(callback: ConnectionStateChangeCallback): () => void {
    this.connectionStateCallbacks.add(callback);
    return () => this.connectionStateCallbacks.delete(callback);
  }

  private setConnectionState(newState: ConnectionState): void {
    if (this.connectionState === newState) return;
    const previous = this.connectionState;
    this.connectionState = newState;

    this.logger.info(`[SwarmChannel] ${previous} → ${newState}`);

    const snapshot = this.getConnectionState();
    for (const cb of this.connectionStateCallbacks) {
      try {
        cb(snapshot);
      } catch { /* listener error */ }
    }
  }

  // ─── Outbox Push (local → Swarm) ─────────────────────────────

  private async handleOutboxAdded(syncOps: SyncOperation[]): Promise<void> {
    if (this.isShutdown || this.connectionState !== "connected") return;
    if (!this.swarmClient) {
      this.resolveSwarmClient();
      if (!this.swarmClient) {
        this.logger.warn("[SwarmChannel] No SwarmClient available — push deferred");
        return;
      }
    }

    for (const syncOp of syncOps) {
      try {
        syncOp.started();
        await this.pushSyncOperation(syncOp);
        syncOp.executed();

        this.pushFailureCount = 0;
        this.pushBlocked = false;
        this.lastSuccessUtcMs = Date.now();
        this.failureCount = 0;
      } catch (err) {
        this.pushFailureCount++;
        this.lastFailureUtcMs = Date.now();
        this.failureCount++;

        const error = new ChannelError(
          ChannelErrorSource.Outbox,
          err instanceof Error ? err : new Error(String(err)),
        );
        syncOp.failed(error);

        if (this.pushFailureCount >= MAX_PUSH_RETRIES) {
          this.logger.warn(
            `[SwarmChannel] Moving to dead letter after ${MAX_PUSH_RETRIES} failures: ${syncOp.documentId}`,
          );
          this.outbox.remove(syncOp);
          this.deadLetter.add(syncOp);
          this.pushBlocked = false;
        } else {
          this.pushBlocked = true;
          this.logger.warn(
            `[SwarmChannel] Push failed (attempt ${this.pushFailureCount}/${MAX_PUSH_RETRIES}): ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  }

  /**
   * Push a single SyncOperation to Swarm.
   *
   * Serializes operations → encrypts → uploads to /bytes → writes feed reference.
   */
  private async pushSyncOperation(syncOp: SyncOperation): Promise<void> {
    const client = this.swarmClient!;
    const ops = syncOp.operations;
    if (ops.length === 0) return;

    const docId = syncOp.documentId;
    const payload = JSON.stringify(ops);

    // Upload encrypted operation batch to /bytes
    const { reference } = await client.uploadData(payload, {
      tracked: false,
      deferred: true,
    });

    // Read current manifest, append batch, write back
    let manifest = await client.readManifest(docId);
    if (!manifest) {
      const docType = ops[0]?.context?.documentType ?? "unknown";
      manifest = {
        documentId: docId,
        documentType: docType,
        operationBatches: [],
        latestRevision: {},
        keyframes: [],
        updatedAt: new Date().toISOString(),
      };
    }

    const startIndex = ops[0]?.operation?.index ?? 0;
    const endIndex = ops[ops.length - 1]?.operation?.index ?? 0;

    const scope = ops[0]?.context?.scope ?? "global";
    const branch = ops[0]?.context?.branch ?? "main";

    manifest.operationBatches.push({
      reference,
      scope,
      branch,
      startIndex,
      endIndex,
      timestamp: new Date().toISOString(),
    });

    // Update latest revision tracking
    for (const op of ops) {
      const scope = op.context?.scope ?? "global";
      const idx = op.operation?.index ?? 0;
      const current = manifest.latestRevision[scope];
      if (current === undefined || idx > current) {
        manifest.latestRevision[scope] = idx;
      }
    }
    manifest.updatedAt = new Date().toISOString();

    await client.updateManifest(docId, manifest);

    this.logger.info(
      `[SwarmChannel] Pushed ${ops.length} ops for ${docId.slice(0, 8)} (indices ${startIndex}-${endIndex})`,
    );
  }

  // ─── Inbox Pull (Swarm → local) ──────────────────────────────

  /** Track which batch references we've already processed (per doc) */
  private processedBatches = new Set<string>();

  /**
   * Poll Swarm feeds for new operations not yet in the local reactor.
   *
   * Reads the user manifest → iterates document manifests → downloads
   * new operation batches → wraps as SyncOperation → adds to inbox.
   * The SyncManager then applies them via reactor.load().
   *
   * Batch deduplication: tracks processed batch references to avoid
   * re-downloading and re-applying the same operations.
   */
  private async pollInbox(): Promise<void> {
    if (this.isShutdown || !this.swarmClient) return;

    const client = this.swarmClient;
    const ownerAddress = this.config.ownerAddress;

    // Read user manifest to discover documents
    let userManifest: any;
    try {
      userManifest = await client.readUserManifest(ownerAddress);
    } catch {
      // User manifest not found — nothing to pull
      return;
    }
    if (!userManifest) return;

    // Discover docs from user manifest + drive manifests
    const docIds = new Set<string>();
    const docMeta = new Map<string, { documentType: string; scope: string }>();

    // Direct documents in user manifest
    for (const [docId, entry] of Object.entries(userManifest.documents ?? {}) as Array<[string, any]>) {
      docIds.add(docId);
      docMeta.set(docId, {
        documentType: entry.documentType ?? "unknown",
        scope: "global",
      });
    }

    // Drive manifests (contains docs grouped by drive)
    for (const [driveId] of Object.entries(userManifest.drives ?? {}) as Array<[string, any]>) {
      docIds.add(driveId);
      docMeta.set(driveId, { documentType: "powerhouse/document-drive", scope: "global" });
      try {
        const dm = await client.readDriveManifest(driveId);
        if (dm?.documents) {
          for (const [docId, entry] of Object.entries(dm.documents) as Array<[string, any]>) {
            docIds.add(docId);
            docMeta.set(docId, {
              documentType: entry.documentType ?? "unknown",
              scope: "global",
            });
          }
        }
      } catch { /* drive manifest not available */ }
    }

    if (docIds.size === 0) return;

    let newOpsCount = 0;

    for (const docId of docIds) {
      try {
        const manifest = await client.readManifest(docId);
        if (!manifest || manifest.operationBatches.length === 0) continue;

        for (const batch of manifest.operationBatches) {
          // Skip batches we've already processed
          const batchKey = `${docId}:${batch.reference}`;
          if (this.processedBatches.has(batchKey)) continue;

          try {
            const data = await client.downloadData(batch.reference);
            const rawOps = JSON.parse(new TextDecoder().decode(data));

            if (!Array.isArray(rawOps) || rawOps.length === 0) {
              this.processedBatches.add(batchKey);
              continue;
            }

            // Normalize: ensure OperationWithContext format.
            // Push cycle writes OperationWithContext[], old plugin writes { index, action }.
            const ops = rawOps.map((op: any) => {
              if (op.operation && op.context) {
                // Already OperationWithContext format
                return op;
              }
              // Old plugin format: { index, action: { type, input, scope, ... } }
              const action = op.action ?? op;
              return {
                operation: {
                  id: action.id ?? op.id ?? crypto.randomUUID(),
                  index: op.index ?? 0,
                  skip: 0,
                  timestampUtcMs: action.timestampUtcMs ?? op.timestampUtcMs ?? new Date().toISOString(),
                  hash: op.hash ?? "",
                  action,
                },
                context: {
                  documentId: docId,
                  documentType: docMeta.get(docId)?.documentType ?? "unknown",
                  scope: action.scope ?? batch.scope ?? "global",
                  branch: batch.branch ?? "main",
                  ordinal: 0,
                },
              };
            });

            const scope = ops[0]?.context?.scope ?? "global";
            const branch = ops[0]?.context?.branch ?? "main";

            const syncOp = new SyncOperation(
              crypto.randomUUID(),
              "",       // jobId — empty for non-keyed (processed individually)
              [],       // jobDependencies
              this.remoteName,
              docId,
              [scope],
              branch,
              ops,
            );

            this.inbox.add(syncOp);
            this.processedBatches.add(batchKey);
            newOpsCount += ops.length;
          } catch (err) {
            this.logger.warn(
              `[SwarmChannel] Failed to download batch ${batch.reference.slice(0, 12)}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      } catch (err) {
        // Manifest read failure — doc may not have ops on Swarm yet
      }
    }

    if (newOpsCount > 0) {
      this.logger.info(`[SwarmChannel] Pulled ${newOpsCount} new ops from Swarm`);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private resolveSwarmClient(): void {
    const ph = (globalThis as any).window?.ph;
    const client = ph?.swarm?.client;
    if (client) {
      this.swarmClient = client as SwarmClient;
    }
  }

  private async checkBeeHealth(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), HEALTH_CHECK_TIMEOUT_MS);
      try {
        const res = await fetch(`${this.config.beeUrl}/health`, {
          signal: ctrl.signal,
        });
        return res.ok;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return false;
    }
  }

  private async persistInboxCursor(): Promise<void> {
    const current = this.inbox.ackOrdinal;
    if (current <= this.lastPersistedInboxOrdinal) return;
    try {
      await this.cursorStorage.upsert({
        remoteName: this.remoteName,
        cursorType: "inbox",
        cursorOrdinal: current,
        lastSyncedAtUtcMs: Date.now(),
      });
      this.lastPersistedInboxOrdinal = current;
    } catch { /* best effort */ }
  }

  private async persistOutboxCursor(): Promise<void> {
    const current = this.outbox.ackOrdinal;
    if (current <= this.lastPersistedOutboxOrdinal) return;
    try {
      await this.cursorStorage.upsert({
        remoteName: this.remoteName,
        cursorType: "outbox",
        cursorOrdinal: current,
        lastSyncedAtUtcMs: Date.now(),
      });
      this.lastPersistedOutboxOrdinal = current;
    } catch { /* best effort */ }
  }
}
