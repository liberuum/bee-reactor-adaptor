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
import {
  ensureDriveInUserManifest,
  updateDriveManifest,
  extractDriveInfoFromOps,
} from "./manifest-manager.js";

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

/** IMailbox type extracted from IChannel — not directly exported by @powerhousedao/reactor */
type IMailbox = IChannel["inbox"];

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
  private initComplete = false;
  private readonly abortController = new AbortController();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  // Cursor persistence tracking
  private lastPersistedInboxOrdinal = 0;
  private lastPersistedOutboxOrdinal = 0;

  // Frozen cursor from init() — used ONLY for the skip logic in handleOutboxAdded.
  // This value never changes after init, so it correctly represents what was
  // pushed in previous sessions. Using lastPersistedOutboxOrdinal for skipping
  // is wrong because it gets updated during the session when child doc ops push
  // (advancing the cursor), then drive ops at lower ordinals get incorrectly skipped.
  private initOutboxCursor = 0;

  // Recovery mode — skip all outbox pushes while inbox pull is in progress.
  // After pullFromSwarm() adds ops to the inbox, the SyncManager processes
  // them asynchronously and may trigger updateOutbox() for OTHER remotes
  // (cross-remote ops). Those outbox items should be skipped, not re-pushed.
  private recoveryInProgress = false;
  private recoveryMaxOrdinal = 0;

  // Serialize manifest writes per document to prevent read-modify-write races.
  // Without this, concurrent pushSyncOperation calls for the same doc read
  // the same manifest, each appends their batch, and the last write wins —
  // losing batches from earlier concurrent writes.
  private manifestLocks = new Map<string, Promise<void>>();

  /** Serialize async work per document ID to prevent read-modify-write races. */
  private async withManifestLock(docId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.manifestLocks.get(docId) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run fn after previous completes (even if it failed)
    this.manifestLocks.set(docId, next);
    try {
      await next;
    } finally {
      // Clean up if this is still the latest lock
      if (this.manifestLocks.get(docId) === next) {
        this.manifestLocks.delete(docId);
      }
    }
  }

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
    this.initOutboxCursor = outboxCursor?.cursorOrdinal ?? 0;

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

    // Inbox poll is NOT started automatically.
    // Normal operation is outbox-only (push local changes to Swarm).
    // Recovery (inbox pull) is triggered explicitly by the registration
    // code in reactor.ts when drives are found on Swarm but not locally.

    this.initComplete = true;
    this.logger.info(
      `[SwarmChannel] Init complete for "${this.remoteName}" — outbox ack: ${this.outbox.ackOrdinal}`,
    );
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
      receivingPages: false,
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
    // Don't push until init() has loaded the cursor from storage.
    // The SyncManager wires callbacks BEFORE init(), so outbox items
    // may arrive with stale cursor position. Wait for init to complete.
    if (!this.initComplete) {
      this.logger.info(`[SwarmChannel] Outbox items deferred — init not complete yet (${syncOps.length} ops)`);
      return;
    }
    if (!this.swarmClient) {
      this.resolveSwarmClient();
      if (!this.swarmClient) {
        this.logger.warn("[SwarmChannel] No SwarmClient available — push deferred");
        return;
      }
    }

    for (const syncOp of syncOps) {
      try {
        // Skip ops that have already been synced to Swarm.
        // On page reload, sync_remotes are deleted and re-added dynamically.
        // syncManager.add() calls updateOutbox(remote, 0) which starts from
        // ordinal 0 (ignoring the channel cursor), unlike startup() which
        // respects outbox.ackOrdinal. We use our persisted cursor to filter.
        const maxOrdinal = Math.max(
          ...syncOp.operations.map((op) => op.context?.ordinal ?? 0),
        );
        if (
          (maxOrdinal > 0 && maxOrdinal <= this.initOutboxCursor) ||
          this.recoveryInProgress
        ) {
          syncOp.started();
          syncOp.executed();
          if (maxOrdinal > this.outbox.ackOrdinal) {
            this.outbox.advanceOrdinal(maxOrdinal);
          }
          if (this.recoveryInProgress && maxOrdinal > this.recoveryMaxOrdinal) {
            this.recoveryMaxOrdinal = maxOrdinal;
          }
          this.outbox.remove(syncOp);
          this.logger.info(
            `[SwarmChannel] Skipped ${this.recoveryInProgress ? "recovery" : "already-synced"} ops for ${syncOp.documentId.slice(0, 8)} (ordinal ${maxOrdinal}, cursor ${this.initOutboxCursor})`,
          );
          continue;
        }

        syncOp.started();
        await this.pushSyncOperation(syncOp);
        syncOp.executed();

        // Advance the outbox cursor and remove the op.
        if (maxOrdinal > this.outbox.ackOrdinal) {
          this.outbox.advanceOrdinal(maxOrdinal);
        }
        this.outbox.remove(syncOp);

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

    // Upload encrypted operation batch to /bytes (can be concurrent)
    const { reference } = await client.uploadData(payload, {
      tracked: false,
      deferred: true,
    });

    const startIndex = ops[0]?.operation?.index ?? 0;
    const endIndex = ops[ops.length - 1]?.operation?.index ?? 0;
    const scope = ops[0]?.context?.scope ?? "global";
    const branch = ops[0]?.context?.branch ?? "main";

    // Diagnostic: log what action types are being pushed per doc/scope.
    // Lets us see (e.g.) that a drive's ADD_FILE is actually leaving the
    // main browser; recovery misses that previously looked like pull bugs
    // were often "the push never happened".
    const actionTypes = ops
      .map((o: any) => o.operation?.action?.type ?? "?")
      .slice(0, 5)
      .join(",");
    this.logger.info(
      `[SwarmChannel] Push ${docId.slice(0, 8)} scope=${scope} idx=${startIndex}-${endIndex} ops=[${actionTypes}${ops.length > 5 ? "…" : ""}]`,
    );

    // Serialize manifest read-modify-write per document.
    // Without this, concurrent pushes for the same doc race:
    // both read manifest with N batches, both append → write N+1,
    // second write overwrites the first → batch lost.
    await this.withManifestLock(docId, async () => {
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

      manifest.operationBatches.push({
        reference,
        scope,
        branch,
        startIndex,
        endIndex,
        timestamp: new Date().toISOString(),
      });

      for (const op of ops) {
        const s = op.context?.scope ?? "global";
        const idx = op.operation?.index ?? 0;
        const current = manifest.latestRevision[s];
        if (current === undefined || idx > current) {
          manifest.latestRevision[s] = idx;
        }
      }
      manifest.updatedAt = new Date().toISOString();

      await client.updateManifest(docId, manifest);
    });

    this.logger.info(
      `[SwarmChannel] Pushed ${ops.length} ops for ${docId.slice(0, 8)} (indices ${startIndex}-${endIndex}, outbox cursor: ${this.outbox.ackOrdinal}→${this.outbox.latestOrdinal})`,
    );

    // Update drive + user manifests after every push.
    // Drive ops (ADD_FILE, SET_DRIVE_NAME) update the drive's own manifest.
    // Child doc ops (edits to files within a drive) also need to trigger a
    // drive manifest update so recovery can discover all child documents.
    const docType = ops[0]?.context?.documentType ?? "";
    const driveId = docType === "powerhouse/document-drive"
      ? docId
      : this.findParentDriveId(docId);

    if (driveId) {
      // Retry manifest update up to 2 times — manifest must be updated for
      // recovery to discover documents. Without it, ops are on Swarm but
      // unreachable during recovery.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.updateDriveAndUserManifests(driveId, ops);
          break;
        } catch (err) {
          if (attempt < 2) {
            this.logger.warn(
              `[SwarmChannel] Manifest update retry ${attempt + 1}/3 for drive ${driveId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`,
            );
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          } else {
            this.logger.error(
              `[SwarmChannel] Manifest update FAILED for drive ${driveId.slice(0, 8)} after 3 attempts — recovery may miss documents: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }
    }
  }

  // ─── Manifest Updates (drive + user) ───────────────────────────

  /**
   * Update drive manifest and user manifest after pushing drive ops.
   *
   * Reads the current drive state from the reactor (via window.ph)
   * for the most accurate nodes/name/editor. Falls back to extracting
   * from operations if reactor isn't accessible.
   */
  private async updateDriveAndUserManifests(
    driveId: string,
    ops: any[],
  ): Promise<void> {
    const client = this.swarmClient;
    if (!client) return;

    // Try to read the live drive state from the reactor
    const ph = (globalThis as any).window?.ph;
    const reactorClient = ph?.reactorClient;

    let driveName = "";
    let preferredEditor: string | undefined;
    let nodes: Array<{ id: string; kind: string; name: string; documentType?: string; parentFolder?: string | null }> = [];

    if (reactorClient) {
      try {
        const driveDoc = await reactorClient.get(driveId);
        driveName = driveDoc?.state?.global?.name ?? "";
        preferredEditor = driveDoc?.header?.meta?.preferredEditor;
        nodes = driveDoc?.state?.global?.nodes ?? [];
      } catch {
        // Reactor doesn't have this drive (maybe it's a Swarm-only ID)
      }
    }

    // Fallback: extract from operations if reactor didn't have it
    if (!driveName && ops.length > 0) {
      const extracted = extractDriveInfoFromOps(ops);
      driveName = extracted.driveName || driveId;
      preferredEditor = extracted.preferredEditor;
      nodes = extracted.nodes;
    }

    if (!driveName) driveName = driveId;

    // Update drive manifest (docs + folders)
    await updateDriveManifest(client, driveId, nodes, driveName, preferredEditor);

    // Update user manifest (drive list)
    await ensureDriveInUserManifest(
      client,
      this.config.ownerAddress,
      driveId,
      driveName,
      preferredEditor,
    );

    // Sync the UI cache so Settings shows the update immediately
    this.syncDriveToUiCache(driveId, driveName, preferredEditor, nodes);
  }

  /**
   * Update window.ph.swarm.userManifest with drive + doc entries
   * so the Settings UI reflects changes without a page refresh.
   */
  private syncDriveToUiCache(
    driveId: string,
    driveName: string,
    preferredEditor: string | undefined,
    nodes: Array<{ id: string; kind: string; name: string; documentType?: string; parentFolder?: string | null }>,
  ): void {
    const ph = (globalThis as any).window?.ph;
    if (!ph?.swarm) return;

    if (!ph.swarm.userManifest) {
      ph.swarm.userManifest = { documents: {}, drives: {}, driveManifests: {} };
    }
    const um = ph.swarm.userManifest;
    const now = new Date().toISOString();

    // Add drive entry
    um.drives = um.drives ?? {};
    um.drives[driveId] = {
      name: driveName,
      documentIds: [],
      preferredEditor,
      lastUpdated: now,
    };

    // Add drive as a document entry (Settings UI reads this)
    um.documents = um.documents ?? {};
    um.documents[driveId] = {
      documentType: "powerhouse/document-drive",
      name: driveName,
      driveId: "",
      lastUpdated: now,
    };

    // Add child docs + folder structure
    const folders: Record<string, { name: string; parentFolder?: string }> = {};
    for (const node of nodes) {
      if (node.kind === "file") {
        um.documents[node.id] = {
          documentType: node.documentType ?? "unknown",
          name: node.name,
          driveId,
          parentFolder: node.parentFolder ?? undefined,
          lastUpdated: now,
        };
      } else if (node.kind === "folder") {
        folders[node.id] = {
          name: node.name,
          parentFolder: node.parentFolder ?? undefined,
        };
      }
    }

    // Store folder info for the Settings tree view
    um.driveManifests = um.driveManifests ?? {};
    if (Object.keys(folders).length > 0) {
      um.driveManifests[driveId] = { folders };
    }
  }

  // ─── Inbox Pull (Swarm → local) ──────────────────────────────

  /** Track which batch references we've already processed (per doc) */
  private processedBatches = new Set<string>();

  /**
   * Pull operations from Swarm feeds for documents not in the local reactor.
   * Called explicitly for recovery (fresh PGlite). NOT called during normal operation.
   * Returns true if new ops were pulled.
   * The SyncManager then applies them via reactor.load().
   *
   * Batch deduplication: tracks processed batch references to avoid
   * re-downloading and re-applying the same operations.
   */
  async pullFromSwarm(): Promise<boolean> {
    if (this.isShutdown || !this.swarmClient) {
      this.logger.warn(
        `[SwarmChannel] pullFromSwarm early-exit: isShutdown=${this.isShutdown} swarmClient=${!!this.swarmClient}`,
      );
      return false;
    }

    this.recoveryInProgress = true;

    const client = this.swarmClient;
    const ownerAddress = this.config.ownerAddress;
    this.logger.info(
      `[SwarmChannel] pullFromSwarm start for ${this.remoteName} (owner=${ownerAddress.slice(0, 10)})`,
    );

    // Read user manifest to discover documents
    let userManifest: any;
    try {
      userManifest = await client.readUserManifest(ownerAddress);
    } catch (err) {
      this.logger.warn(
        `[SwarmChannel] pullFromSwarm: readUserManifest threw: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
    if (!userManifest) {
      this.logger.warn(
        `[SwarmChannel] pullFromSwarm: user manifest is null for owner=${ownerAddress.slice(0, 10)}`,
      );
      return false;
    }

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

    if (docIds.size === 0) {
      this.logger.warn(
        `[SwarmChannel] pullFromSwarm: no docs in user manifest (drives=${Object.keys(userManifest.drives ?? {}).length}, docs=${Object.keys(userManifest.documents ?? {}).length})`,
      );
      return false;
    }

    this.logger.info(
      `[SwarmChannel] pullFromSwarm found ${docIds.size} doc(s) in manifest: ${[...docIds].map((id) => id.slice(0, 8)).join(", ")}`,
    );

    // Filter out documents that already exist in the local reactor.
    // The outbox handles pushing local ops to Swarm — the inbox should
    // only pull ops for documents that need recovery (don't exist locally).
    //
    // Only filter docs that were present BEFORE this recovery session.
    // During recovery, another SwarmChannel may be concurrently loading
    // docs via its inbox — those partially-loaded docs should not be
    // filtered out. We use processedBatches as a proxy: if we already
    // pulled a batch for this doc, skip it (prevents duplicate pulls
    // from the same channel).
    const ph = (globalThis as any).window?.ph;
    const reactorClient = ph?.reactorClient;
    if (reactorClient && !this.recoveryInProgress) {
      // Only apply filter when NOT in a recovery session (normal operation).
      // During recovery, let all docs through — duplicates are handled by
      // processedBatches set and reactor.load() idempotency.
      const localDocIds = new Set<string>();
      try {
        const drives = await reactorClient.getDrives();
        for (const drive of drives ?? []) {
          const did = drive?.id ?? drive?.header?.id ?? drive;
          if (did) localDocIds.add(String(did));
          try {
            const driveDoc = await reactorClient.get(String(did));
            for (const node of driveDoc?.state?.global?.nodes ?? []) {
              if (node?.id) localDocIds.add(node.id);
            }
          } catch { /* drive not accessible */ }
        }
      } catch { /* no drives */ }

      if (localDocIds.size > 0) {
        for (const localId of localDocIds) {
          docIds.delete(localId);
        }
      }
    }

    if (docIds.size === 0) {
      this.logger.warn(
        `[SwarmChannel] pullFromSwarm: all docs filtered out as local-present (nothing to recover)`,
      );
      return false;
    }

    this.logger.info(
      `[SwarmChannel] Recovery: ${docIds.size} docs to pull: ${[...docIds].map(id => id.slice(0, 8)).join(", ")}`,
    );

    // Process drives first (they must exist before child docs can reference them).
    // Drives are document-drive type; all others are child documents.
    const driveIds: string[] = [];
    const childDocIds: string[] = [];
    for (const docId of docIds) {
      const meta = docMeta.get(docId);
      if (meta?.documentType === "powerhouse/document-drive") {
        driveIds.push(docId);
      } else {
        childDocIds.push(docId);
      }
    }
    const orderedDocIds = [...driveIds, ...childDocIds];

    let newOpsCount = 0;

    for (const docId of orderedDocIds) {
      try {
        const manifest = await client.readManifest(docId);
        if (!manifest || manifest.operationBatches.length === 0) continue;

        // Collect ALL ops from ALL batches for this document first,
        // then sort by scope (document first) and index. This ensures
        // CREATE_DOCUMENT runs before any global ops, regardless of
        // the order batches were pushed to Swarm.
        const allOps: any[] = [];

        for (const batch of manifest.operationBatches) {
          const batchKey = `${docId}:${batch.reference}`;
          if (this.processedBatches.has(batchKey)) continue;

          try {
            const data = await client.downloadData(batch.reference);
            const rawOps = JSON.parse(new TextDecoder().decode(data));

            if (!Array.isArray(rawOps) || rawOps.length === 0) {
              this.processedBatches.add(batchKey);
              continue;
            }

            for (const op of rawOps) {
              if (op.operation && op.context) {
                allOps.push(op);
              } else {
                const action = op.action ?? op;
                allOps.push({
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
                });
              }
            }

            this.processedBatches.add(batchKey);
          } catch (err) {
            this.logger.warn(
              `[SwarmChannel] Failed to download batch ${batch.reference.slice(0, 12)}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }

        if (allOps.length === 0) continue;

        // Group by scope and sort ops within each scope by index
        const byScope = new Map<string, any[]>();
        for (const op of allOps) {
          const scope = op.context?.scope ?? "global";
          if (!byScope.has(scope)) byScope.set(scope, []);
          byScope.get(scope)!.push(op);
        }
        for (const [, ops] of byScope) {
          ops.sort((a: any, b: any) => (a.operation?.index ?? 0) - (b.operation?.index ?? 0));
        }

        // Process "document" scope first (creates the document), then others
        const scopeOrder = ["document", ...Array.from(byScope.keys()).filter(s => s !== "document")];
        const branch = allOps[0]?.context?.branch ?? "main";

        // Diagnostic: summarize what's in each scope so recovery problems
        // (missing ADD_FILE, ops stuck in wrong scope, etc.) are visible
        // without having to instrument a live session.
        const scopeSummary = scopeOrder
          .map((s) => {
            const ops = byScope.get(s) ?? [];
            const actionTypes = ops
              .map((o: any) => o.operation?.action?.type ?? "?")
              .slice(0, 5)
              .join(",");
            return `${s}=${ops.length}${ops.length > 0 ? `[${actionTypes}${ops.length > 5 ? "…" : ""}]` : ""}`;
          })
          .join(" ");
        this.logger.info(
          `[SwarmChannel] Pull doc ${docId.slice(0, 8)} (${docMeta.get(docId)?.documentType ?? "?"}): ${scopeSummary}`,
        );

        for (const scope of scopeOrder) {
          const scopeOps = byScope.get(scope);
          if (!scopeOps || scopeOps.length === 0) continue;

          const syncOp = new SyncOperation(
            crypto.randomUUID(),
            "",
            [],
            this.remoteName,
            docId,
            [scope],
            branch,
            scopeOps,
          );

          this.inbox.add(syncOp);
          newOpsCount += scopeOps.length;
        }
      } catch (err) {
        if (err instanceof Error && !err.message.includes("404")) {
          this.logger.warn(`[SwarmChannel] Manifest read failed for ${docId.slice(0, 8)}: ${err.message}`);
        }
      }
    }

    if (newOpsCount > 0) {
      this.logger.info(`[SwarmChannel] Pulled ${newOpsCount} new ops from Swarm`);
    }

    // Keep recoveryInProgress=true for a short window to catch outbox items
    // triggered by the SyncManager processing our inbox ops asynchronously.
    // After 5s, clear the flag and persist the outbox cursor at whatever
    // ordinal the mailbox has reached — future reloads will skip up to there.
    // Update UI recovery flag on window.ph.swarm
    const phSwarm = (globalThis as any).window?.ph?.swarm;

    if (newOpsCount > 0) {
      if (phSwarm) phSwarm.recovering = true;
      setTimeout(() => {
        this.recoveryInProgress = false;
        if (phSwarm) phSwarm.recovering = false;

        // After recovery, advance the outbox cursor to the highest ordinal
        // seen during the recovery window. This prevents re-pushes on reload.
        // recoveryMaxOrdinal tracks the highest ordinal from skipped outbox ops.
        const maxSeen = Math.max(
          this.outbox.ackOrdinal,
          this.outbox.latestOrdinal,
          this.recoveryMaxOrdinal,
        );
        if (maxSeen > 0 && maxSeen > this.lastPersistedOutboxOrdinal) {
          this.outbox.advanceOrdinal(maxSeen);
          this.lastPersistedOutboxOrdinal = maxSeen;
        }
        this.recoveryMaxOrdinal = 0;
        this.persistOutboxCursor().catch(() => {});
        this.logger.info(
          `[SwarmChannel] Recovery complete — outbox cursor persisted at ${this.outbox.ackOrdinal}`,
        );
      }, 5000);
    } else {
      this.recoveryInProgress = false;
      if (phSwarm) phSwarm.recovering = false;
    }

    return newOpsCount > 0;
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /**
   * Find the parent drive ID for a child document.
   * Uses the plugin's docToDrive mapping (populated by hydration.ts),
   * or falls back to querying the reactor for the drive that contains this doc.
   */
  private findParentDriveId(docId: string): string | null {
    const ph = (globalThis as any).window?.ph;

    // Fast path: plugin state has the mapping
    const docToDrive = ph?.swarm?.docToDrive;
    if (docToDrive instanceof Map && docToDrive.has(docId)) {
      return docToDrive.get(docId) ?? null;
    }

    // Fallback: extract from the remote name (format: "swarm:{driveId}")
    // The collectionId is "drive.main.{driveId}" — we can extract the driveId
    const collectionId = this.config.collectionId;
    const match = collectionId.match(/^drive\.main\.(.+)$/);
    if (match) return match[1];

    return null;
  }

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
