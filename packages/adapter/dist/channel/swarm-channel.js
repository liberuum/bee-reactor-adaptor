import { Mailbox, SyncOperation, ChannelError, ChannelErrorSource, } from "@powerhousedao/reactor";
import { ensureDriveInUserManifest, updateDriveManifest, extractDriveInfoFromOps, } from "./manifest-manager.js";
// ═══════════════════════════════════════════════════════════════
// Health Check Constants
// ═══════════════════════════════════════════════════════════════
const HEALTH_CHECK_TIMEOUT_MS = 3000;
const HEALTH_CHECK_INTERVAL_MS = 15000;
const MAX_PUSH_RETRIES = 3;
export class SwarmChannel {
    inbox;
    outbox;
    deadLetter;
    channelId;
    remoteName;
    cursorStorage;
    operationIndex;
    config;
    logger;
    // Connection state
    connectionState = "connecting";
    connectionStateCallbacks = new Set();
    failureCount = 0;
    lastSuccessUtcMs = 0;
    lastFailureUtcMs = 0;
    pushFailureCount = 0;
    pushBlocked = false;
    // Lifecycle
    isShutdown = false;
    initComplete = false;
    abortController = new AbortController();
    pollTimer = null;
    healthTimer = null;
    // Cursor persistence tracking
    lastPersistedInboxOrdinal = 0;
    lastPersistedOutboxOrdinal = 0;
    // Recovery mode — skip all outbox pushes while inbox pull is in progress.
    // After pullFromSwarm() adds ops to the inbox, the SyncManager processes
    // them asynchronously and may trigger updateOutbox() for OTHER remotes
    // (cross-remote ops). Those outbox items should be skipped, not re-pushed.
    recoveryInProgress = false;
    // SwarmClient — set during init() after wallet key derivation
    swarmClient = null;
    constructor(logger, channelId, remoteName, cursorStorage, config, operationIndex) {
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
        this.outbox.onAdded((syncOps) => {
            this.handleOutboxAdded(syncOps).catch((err) => {
                this.logger.error("[SwarmChannel] Outbox handler error:", err);
            });
        });
        // Persist inbox cursor when items are removed (processed by SyncManager)
        this.inbox.onRemoved(() => {
            this.persistInboxCursor().catch(() => { });
        });
        // Persist outbox cursor when items are removed (acknowledged)
        this.outbox.onRemoved(() => {
            this.persistOutboxCursor().catch(() => { });
        });
    }
    // ─── Lifecycle ────────────────────────────────────────────────
    async init() {
        this.logger.info(`[SwarmChannel] Initializing for remote "${this.remoteName}"`);
        // Load persisted cursors
        const inboxCursor = await this.cursorStorage.get(this.remoteName, "inbox");
        const outboxCursor = await this.cursorStorage.get(this.remoteName, "outbox");
        this.inbox.init(inboxCursor?.cursorOrdinal ?? 0);
        this.outbox.init(outboxCursor?.cursorOrdinal ?? 0);
        this.lastPersistedInboxOrdinal = inboxCursor?.cursorOrdinal ?? 0;
        this.lastPersistedOutboxOrdinal = outboxCursor?.cursorOrdinal ?? 0;
        this.logger.info(`[SwarmChannel] Cursors loaded — inbox: ${this.inbox.ackOrdinal}, outbox: ${this.outbox.ackOrdinal}`);
        // Resolve SwarmClient from window.ph.swarm (set by existing plugin init)
        this.resolveSwarmClient();
        // Check Bee node health
        const healthy = await this.checkBeeHealth();
        if (healthy) {
            this.setConnectionState("connected");
        }
        else {
            this.setConnectionState("reconnecting");
        }
        // Start health check timer
        this.healthTimer = setInterval(() => {
            this.checkBeeHealth().then((ok) => {
                if (ok && this.connectionState !== "connected") {
                    this.setConnectionState("connected");
                }
                else if (!ok && this.connectionState === "connected") {
                    this.setConnectionState("reconnecting");
                }
            }).catch(() => { });
        }, HEALTH_CHECK_INTERVAL_MS);
        // Inbox poll is NOT started automatically.
        // Normal operation is outbox-only (push local changes to Swarm).
        // Recovery (inbox pull) is triggered explicitly by the registration
        // code in reactor.ts when drives are found on Swarm but not locally.
        this.initComplete = true;
        this.logger.info(`[SwarmChannel] Init complete for "${this.remoteName}" — outbox ack: ${this.outbox.ackOrdinal}`);
    }
    async shutdown() {
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
    getConnectionState() {
        return {
            state: this.connectionState,
            failureCount: this.failureCount,
            lastSuccessUtcMs: this.lastSuccessUtcMs,
            lastFailureUtcMs: this.lastFailureUtcMs,
            pushBlocked: this.pushBlocked,
            pushFailureCount: this.pushFailureCount,
        };
    }
    onConnectionStateChange(callback) {
        this.connectionStateCallbacks.add(callback);
        return () => this.connectionStateCallbacks.delete(callback);
    }
    setConnectionState(newState) {
        if (this.connectionState === newState)
            return;
        const previous = this.connectionState;
        this.connectionState = newState;
        this.logger.info(`[SwarmChannel] ${previous} → ${newState}`);
        const snapshot = this.getConnectionState();
        for (const cb of this.connectionStateCallbacks) {
            try {
                cb(snapshot);
            }
            catch { /* listener error */ }
        }
    }
    // ─── Outbox Push (local → Swarm) ─────────────────────────────
    async handleOutboxAdded(syncOps) {
        if (this.isShutdown || this.connectionState !== "connected")
            return;
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
                const maxOrdinal = Math.max(...syncOp.operations.map((op) => op.context?.ordinal ?? 0));
                if ((maxOrdinal > 0 && maxOrdinal <= this.lastPersistedOutboxOrdinal) ||
                    this.recoveryInProgress) {
                    syncOp.started();
                    syncOp.executed();
                    if (maxOrdinal > this.outbox.ackOrdinal) {
                        this.outbox.advanceOrdinal(maxOrdinal);
                    }
                    this.outbox.remove(syncOp);
                    this.logger.info(`[SwarmChannel] Skipped ${this.recoveryInProgress ? "recovery" : "already-synced"} ops for ${syncOp.documentId.slice(0, 8)} (ordinal ${maxOrdinal}, cursor ${this.lastPersistedOutboxOrdinal})`);
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
            }
            catch (err) {
                this.pushFailureCount++;
                this.lastFailureUtcMs = Date.now();
                this.failureCount++;
                const error = new ChannelError(ChannelErrorSource.Outbox, err instanceof Error ? err : new Error(String(err)));
                syncOp.failed(error);
                if (this.pushFailureCount >= MAX_PUSH_RETRIES) {
                    this.logger.warn(`[SwarmChannel] Moving to dead letter after ${MAX_PUSH_RETRIES} failures: ${syncOp.documentId}`);
                    this.outbox.remove(syncOp);
                    this.deadLetter.add(syncOp);
                    this.pushBlocked = false;
                }
                else {
                    this.pushBlocked = true;
                    this.logger.warn(`[SwarmChannel] Push failed (attempt ${this.pushFailureCount}/${MAX_PUSH_RETRIES}): ${err instanceof Error ? err.message : err}`);
                }
            }
        }
    }
    /**
     * Push a single SyncOperation to Swarm.
     *
     * Serializes operations → encrypts → uploads to /bytes → writes feed reference.
     */
    async pushSyncOperation(syncOp) {
        const client = this.swarmClient;
        const ops = syncOp.operations;
        if (ops.length === 0)
            return;
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
        this.logger.info(`[SwarmChannel] Pushed ${ops.length} ops for ${docId.slice(0, 8)} (indices ${startIndex}-${endIndex}, outbox cursor: ${this.outbox.ackOrdinal}→${this.outbox.latestOrdinal})`);
        // Update drive + user manifests for drive documents.
        // Drive ops contain ADD_FILE, ADD_FOLDER, MOVE_NODE etc. that define
        // the folder structure. We extract this and write to the drive manifest.
        const docType = ops[0]?.context?.documentType ?? "";
        if (docType === "powerhouse/document-drive") {
            try {
                await this.updateDriveAndUserManifests(docId, ops);
            }
            catch (err) {
                this.logger.warn(`[SwarmChannel] Manifest update failed for drive ${docId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
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
    async updateDriveAndUserManifests(driveId, ops) {
        const client = this.swarmClient;
        if (!client)
            return;
        // Try to read the live drive state from the reactor
        const ph = globalThis.window?.ph;
        const reactorClient = ph?.reactorClient;
        let driveName = "";
        let preferredEditor;
        let nodes = [];
        if (reactorClient) {
            try {
                const driveDoc = await reactorClient.get(driveId);
                driveName = driveDoc?.state?.global?.name ?? "";
                preferredEditor = driveDoc?.header?.meta?.preferredEditor;
                nodes = driveDoc?.state?.global?.nodes ?? [];
            }
            catch {
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
        if (!driveName)
            driveName = driveId;
        // Update drive manifest (docs + folders)
        await updateDriveManifest(client, driveId, nodes, driveName, preferredEditor);
        // Update user manifest (drive list)
        await ensureDriveInUserManifest(client, this.config.ownerAddress, driveId, driveName, preferredEditor);
        // Sync the UI cache so Settings shows the update immediately
        this.syncDriveToUiCache(driveId, driveName, preferredEditor, nodes);
    }
    /**
     * Update window.ph.swarm.userManifest with drive + doc entries
     * so the Settings UI reflects changes without a page refresh.
     */
    syncDriveToUiCache(driveId, driveName, preferredEditor, nodes) {
        const ph = globalThis.window?.ph;
        if (!ph?.swarm)
            return;
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
        const folders = {};
        for (const node of nodes) {
            if (node.kind === "file") {
                um.documents[node.id] = {
                    documentType: node.documentType ?? "unknown",
                    name: node.name,
                    driveId,
                    parentFolder: node.parentFolder ?? undefined,
                    lastUpdated: now,
                };
            }
            else if (node.kind === "folder") {
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
    processedBatches = new Set();
    /**
     * Pull operations from Swarm feeds for documents not in the local reactor.
     * Called explicitly for recovery (fresh PGlite). NOT called during normal operation.
     * Returns true if new ops were pulled.
     * The SyncManager then applies them via reactor.load().
     *
     * Batch deduplication: tracks processed batch references to avoid
     * re-downloading and re-applying the same operations.
     */
    async pullFromSwarm() {
        if (this.isShutdown || !this.swarmClient)
            return false;
        this.recoveryInProgress = true;
        const client = this.swarmClient;
        const ownerAddress = this.config.ownerAddress;
        // Read user manifest to discover documents
        let userManifest;
        try {
            userManifest = await client.readUserManifest(ownerAddress);
        }
        catch {
            // User manifest not found — nothing to pull
            return false;
        }
        if (!userManifest)
            return false;
        // Discover docs from user manifest + drive manifests
        const docIds = new Set();
        const docMeta = new Map();
        // Direct documents in user manifest
        for (const [docId, entry] of Object.entries(userManifest.documents ?? {})) {
            docIds.add(docId);
            docMeta.set(docId, {
                documentType: entry.documentType ?? "unknown",
                scope: "global",
            });
        }
        // Drive manifests (contains docs grouped by drive)
        for (const [driveId] of Object.entries(userManifest.drives ?? {})) {
            docIds.add(driveId);
            docMeta.set(driveId, { documentType: "powerhouse/document-drive", scope: "global" });
            try {
                const dm = await client.readDriveManifest(driveId);
                if (dm?.documents) {
                    for (const [docId, entry] of Object.entries(dm.documents)) {
                        docIds.add(docId);
                        docMeta.set(docId, {
                            documentType: entry.documentType ?? "unknown",
                            scope: "global",
                        });
                    }
                }
            }
            catch { /* drive manifest not available */ }
        }
        if (docIds.size === 0)
            return false;
        // Filter out documents that already exist in the local reactor.
        // The outbox handles pushing local ops to Swarm — the inbox should
        // only pull ops for documents that need recovery (don't exist locally).
        const ph = globalThis.window?.ph;
        const reactorClient = ph?.reactorClient;
        if (reactorClient) {
            const localDocIds = new Set();
            try {
                const drives = await reactorClient.getDrives();
                for (const drive of drives ?? []) {
                    const did = drive?.id ?? drive?.header?.id ?? drive;
                    if (did)
                        localDocIds.add(String(did));
                    try {
                        const driveDoc = await reactorClient.get(String(did));
                        for (const node of driveDoc?.state?.global?.nodes ?? []) {
                            if (node?.id)
                                localDocIds.add(node.id);
                        }
                    }
                    catch { /* drive not accessible */ }
                }
            }
            catch { /* no drives */ }
            // Remove locally-existing docs from the pull list
            if (localDocIds.size > 0) {
                for (const localId of localDocIds) {
                    docIds.delete(localId);
                }
            }
        }
        if (docIds.size === 0)
            return false;
        // Process drives first (they must exist before child docs can reference them).
        // Drives are document-drive type; all others are child documents.
        const driveIds = [];
        const childDocIds = [];
        for (const docId of docIds) {
            const meta = docMeta.get(docId);
            if (meta?.documentType === "powerhouse/document-drive") {
                driveIds.push(docId);
            }
            else {
                childDocIds.push(docId);
            }
        }
        const orderedDocIds = [...driveIds, ...childDocIds];
        let newOpsCount = 0;
        for (const docId of orderedDocIds) {
            try {
                const manifest = await client.readManifest(docId);
                if (!manifest || manifest.operationBatches.length === 0)
                    continue;
                for (const batch of manifest.operationBatches) {
                    // Skip batches we've already processed
                    const batchKey = `${docId}:${batch.reference}`;
                    if (this.processedBatches.has(batchKey))
                        continue;
                    try {
                        const data = await client.downloadData(batch.reference);
                        const rawOps = JSON.parse(new TextDecoder().decode(data));
                        if (!Array.isArray(rawOps) || rawOps.length === 0) {
                            this.processedBatches.add(batchKey);
                            continue;
                        }
                        // Normalize: ensure OperationWithContext format.
                        // Push cycle writes OperationWithContext[], old plugin writes { index, action }.
                        const ops = rawOps.map((op) => {
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
                        // Group operations by scope — reactor.load() processes one scope at a time.
                        // "document" scope ops (CREATE_DOCUMENT, UPGRADE_DOCUMENT) must be
                        // loaded before "global" scope ops (ADD_FILE, SET_DRIVE_NAME, etc.).
                        const byScope = new Map();
                        for (const op of ops) {
                            const scope = op.context?.scope ?? "global";
                            if (!byScope.has(scope))
                                byScope.set(scope, []);
                            byScope.get(scope).push(op);
                        }
                        // Process "document" scope first (creates the document), then others
                        const scopeOrder = ["document", ...Array.from(byScope.keys()).filter(s => s !== "document")];
                        const branch = ops[0]?.context?.branch ?? "main";
                        for (const scope of scopeOrder) {
                            const scopeOps = byScope.get(scope);
                            if (!scopeOps || scopeOps.length === 0)
                                continue;
                            const syncOp = new SyncOperation(crypto.randomUUID(), "", // jobId — empty for non-keyed (processed individually)
                            [], // jobDependencies
                            this.remoteName, docId, [scope], branch, scopeOps);
                            this.inbox.add(syncOp);
                            newOpsCount += scopeOps.length;
                        }
                        this.processedBatches.add(batchKey);
                    }
                    catch (err) {
                        this.logger.warn(`[SwarmChannel] Failed to download batch ${batch.reference.slice(0, 12)}: ${err instanceof Error ? err.message : err}`);
                    }
                }
            }
            catch (err) {
                // Only log unexpected errors — missing manifests are normal for new docs
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
        const phSwarm = globalThis.window?.ph?.swarm;
        if (newOpsCount > 0) {
            if (phSwarm)
                phSwarm.recovering = true;
            setTimeout(() => {
                this.recoveryInProgress = false;
                if (phSwarm)
                    phSwarm.recovering = false;
                this.persistOutboxCursor().catch(() => { });
                this.logger.info(`[SwarmChannel] Recovery complete — outbox cursor persisted at ${this.outbox.ackOrdinal}`);
            }, 5000);
        }
        else {
            this.recoveryInProgress = false;
            if (phSwarm)
                phSwarm.recovering = false;
        }
        return newOpsCount > 0;
    }
    // ─── Helpers ──────────────────────────────────────────────────
    resolveSwarmClient() {
        const ph = globalThis.window?.ph;
        const client = ph?.swarm?.client;
        if (client) {
            this.swarmClient = client;
        }
    }
    async checkBeeHealth() {
        try {
            const ctrl = new AbortController();
            const timeout = setTimeout(() => ctrl.abort(), HEALTH_CHECK_TIMEOUT_MS);
            try {
                const res = await fetch(`${this.config.beeUrl}/health`, {
                    signal: ctrl.signal,
                });
                return res.ok;
            }
            finally {
                clearTimeout(timeout);
            }
        }
        catch {
            return false;
        }
    }
    async persistInboxCursor() {
        const current = this.inbox.ackOrdinal;
        if (current <= this.lastPersistedInboxOrdinal)
            return;
        try {
            await this.cursorStorage.upsert({
                remoteName: this.remoteName,
                cursorType: "inbox",
                cursorOrdinal: current,
                lastSyncedAtUtcMs: Date.now(),
            });
            this.lastPersistedInboxOrdinal = current;
        }
        catch { /* best effort */ }
    }
    async persistOutboxCursor() {
        const current = this.outbox.ackOrdinal;
        if (current <= this.lastPersistedOutboxOrdinal)
            return;
        try {
            await this.cursorStorage.upsert({
                remoteName: this.remoteName,
                cursorType: "outbox",
                cursorOrdinal: current,
                lastSyncedAtUtcMs: Date.now(),
            });
            this.lastPersistedOutboxOrdinal = current;
        }
        catch { /* best effort */ }
    }
}
//# sourceMappingURL=swarm-channel.js.map