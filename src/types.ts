/**
 * Configuration for the BeeReactorAdapter.
 */
export interface BeeAdapterConfig {
  /** URL of the Bee node API (e.g. "http://localhost:1633") */
  beeUrl: string;

  /** Postage stamp batch ID for uploads */
  batchId: string;

  /** Private key (hex string) for signing Swarm feed updates (secp256k1) */
  signerPrivateKey: string;

  /** Document IDs to track and hydrate from Swarm on startup */
  trackedDocuments?: string[];

  /** Polling interval in ms for checking Swarm feeds for updates (default: 30000) */
  pollIntervalMs?: number;

  /** Use Swarm feeds (SOC) for manifest storage. Set false for bee dev mode. Default: true */
  useFeedMode?: boolean;
}

/**
 * Manifest stored in a Swarm feed for each document.
 * This is the mutable pointer that tracks all operation batches and keyframes
 * uploaded to Swarm for a given document.
 */
export interface SwarmDocumentManifest {
  documentId: string;
  documentType: string;

  /** Map of scope -> latest operation index */
  latestRevision: Record<string, number>;

  /** Ordered list of operation batch references on Swarm */
  operationBatches: OperationBatchEntry[];

  /** List of keyframe references on Swarm */
  keyframes: KeyframeEntry[];

  /** Whether operation batches are AES-256-GCM encrypted */
  encrypted?: boolean;

  updatedAt: string;
}

export interface OperationBatchEntry {
  /** Swarm content-addressed reference (hex hash) */
  reference: string;
  scope: string;
  branch: string;
  startIndex: number;
  endIndex: number;
  timestamp: string;
}

export interface KeyframeEntry {
  /** Swarm content-addressed reference (hex hash) */
  reference: string;
  scope: string;
  branch: string;
  revision: number;
}

/**
 * Task queued for retry after a failed Swarm upload.
 */
export interface RetryTask {
  type: "operation" | "keyframe";
  documentId: string;
  scope: string;
  branch: string;
  revision: number;
  attempts: number;
  lastAttemptAt: number;
}

/**
 * User-level manifest stored on Swarm, keyed by Ethereum address.
 * Indexes all documents belonging to a user so they can be discovered
 * on login from any device.
 *
 * Feed topic: "ph:user:<address>"
 */
export interface SwarmUserManifest {
  /** User's Ethereum address (checksummed) */
  address: string;

  /** User's Bee node compressed secp256k1 public key (for ACT sharing) */
  beeNodePublicKey?: string;

  /** Documents indexed by documentId */
  documents: Record<string, UserDocumentEntry>;

  /** Drives the user has interacted with */
  drives: Record<string, UserDriveEntry>;

  /** Stamp info for monitoring storage health */
  stamps: Record<string, UserStampEntry>;

  updatedAt: string;
}

export interface UserDocumentEntry {
  documentType: string;
  name: string;
  /** Which drive this document belongs to */
  driveId: string;
  /** Swarm reference to the document's SwarmDocumentManifest */
  manifestReference?: string;
  lastUpdated: string;
}

export interface UserDriveEntry {
  name: string;
  documentIds: string[];
  lastUpdated: string;
}

export interface UserStampEntry {
  /** Seconds remaining until stamp expires */
  batchTTL: number;
  /** Percentage of stamp capacity used (0-100) */
  utilization: number;
  /** When this status was last checked */
  lastChecked: string;
}

/**
 * Stamp status returned by SwarmClient.getStampStatus()
 */
export interface StampStatus {
  batchId: string;
  usable: boolean;
  /** Seconds remaining */
  ttlSeconds: number;
  /** Human-readable duration (e.g. "28 days") */
  ttlHuman: string;
  /** Percentage used (0-100) — computed from effective size, not raw utilization */
  utilization: number;
  /** Total effective capacity in bytes (accounts for bucketDepth) */
  capacityBytes: number;
  /** Bytes used so far */
  usedBytes: number;
  /** Bytes remaining */
  remainingBytes: number;
  /** Human-readable capacity (e.g. "4.29 GB") from bee-js */
  capacityHuman: string;
  /** Human-readable remaining (e.g. "4.28 GB") from bee-js */
  remainingHuman: string;
  /** ISO timestamp when stamp expires */
  expiresAt: string;
  /** Batch depth (determines number of chunks) */
  depth: number;
  /** Bucket depth (internal, used for utilization calculation) */
  bucketDepth: number;
  /** Raw utilization counter from bee-js (not a percentage) */
  rawUtilization: number;
  /** Max utilization = 2^(depth - bucketDepth) */
  maxUtilization: number;
  /** Health status based on TTL thresholds */
  health: "healthy" | "warning" | "critical" | "expired";
}
