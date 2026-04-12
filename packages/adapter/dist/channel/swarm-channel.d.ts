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
import type { IOperationIndex, ISyncCursorStorage, ConnectionStateChangeCallback, IChannel, ConnectionStateSnapshot, RemoteFilter } from "@powerhousedao/reactor";
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
/** IMailbox type extracted from IChannel — not directly exported by @powerhousedao/reactor */
type IMailbox = IChannel["inbox"];
export declare class SwarmChannel implements IChannel {
    readonly inbox: IMailbox;
    readonly outbox: IMailbox;
    readonly deadLetter: IMailbox;
    private readonly channelId;
    private readonly remoteName;
    private readonly cursorStorage;
    private readonly operationIndex;
    private readonly config;
    private readonly logger;
    private connectionState;
    private readonly connectionStateCallbacks;
    private failureCount;
    private lastSuccessUtcMs;
    private lastFailureUtcMs;
    private pushFailureCount;
    private pushBlocked;
    private isShutdown;
    private readonly abortController;
    private pollTimer;
    private healthTimer;
    private lastPersistedInboxOrdinal;
    private lastPersistedOutboxOrdinal;
    private swarmClient;
    constructor(logger: ILogger, channelId: string, remoteName: string, cursorStorage: ISyncCursorStorage, config: SwarmChannelConfig, operationIndex: IOperationIndex);
    init(): Promise<void>;
    shutdown(): Promise<void>;
    getConnectionState(): ConnectionStateSnapshot;
    onConnectionStateChange(callback: ConnectionStateChangeCallback): () => void;
    private setConnectionState;
    private handleOutboxAdded;
    /**
     * Push a single SyncOperation to Swarm.
     *
     * Serializes operations → encrypts → uploads to /bytes → writes feed reference.
     */
    private pushSyncOperation;
    /**
     * Update drive manifest and user manifest after pushing drive ops.
     *
     * Reads the current drive state from the reactor (via window.ph)
     * for the most accurate nodes/name/editor. Falls back to extracting
     * from operations if reactor isn't accessible.
     */
    private updateDriveAndUserManifests;
    /** Track which batch references we've already processed (per doc) */
    private processedBatches;
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
    private pollInbox;
    private resolveSwarmClient;
    private checkBeeHealth;
    private persistInboxCursor;
    private persistOutboxCursor;
}
export {};
//# sourceMappingURL=swarm-channel.d.ts.map