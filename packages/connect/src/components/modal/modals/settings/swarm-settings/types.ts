/** Snapshot from SwarmConnectPlugin / window.ph.swarm (loose typing for fork UI). */
export type SwarmUiSnapshot = {
  ready?: boolean;
  /** Plugin lifecycle status for loading UI */
  status?: "initializing" | "disconnected" | "no-stamp" | "ready";
  statusMessage?: string;
  plugin?: { clearCache: () => Promise<void> };
  reconnect?: () => Promise<void>;
  clearStorage?: () => Promise<void>;
  stampStatus?: {
    capacityBytes: number;
    usedBytes?: number;
    remainingBytes?: number;
    capacityHuman?: string;
    remainingHuman?: string;
    utilization: number;
    health: string;
    ttlHuman: string;
    expiresAt?: string;
    depth?: number;
    bucketDepth?: number;
    batchId?: string;
    totalCostBzz?: string;
    totalCostUsd?: string | null;
    bzzUsdPrice?: number | null;
    /** Whether the stamp is immutable (true) or mutable (false) */
    immutable?: boolean;
    /** Warnings about stamp configuration */
    warnings?: string[];
  };
  userManifest?: {
    documents: Record<
      string,
      { name?: string; documentType?: string; driveId?: string; parentFolder?: string }
    >;
    /** Drive manifests with folder info */
    driveManifests?: Record<
      string,
      { folders?: Record<string, { name: string; parentFolder?: string }> }
    >;
  };
  signerEntry?: {
    /** ownerAddress from SwarmSignerEntry (wallet-signer.ts) */
    ownerAddress?: string;
    swarmPublicKey?: string;
  };
  client?: {
    topUpStamp: (amount: string) => Promise<void>;
    expandStamp: (depth: number) => Promise<void>;
    createStamp: (amount: string, depth: number, options?: { immutable?: boolean }) => Promise<string>;
    getStampOptions?: () => Promise<{
      currentDepth: number;
      currentTtlSeconds: number;
      pricePerBlock: number;
      blockTime: number;
      sizeOptions: Array<{ depth: number; label: string; effectiveBytes: number }>;
      durationOptions: Array<{ days: number; label: string; amount: string }>;
    }>;
  };
  /** Whether the Bee node is running in dev mode (no stamp management) */
  isDevMode?: boolean;
  nodeWallet?: string;
  nodeBalances?: { xBZZ: string; xDAI: string };
  /** Per-document sync status */
  syncStatus?: Record<
    string,
    { state: "buffered" | "flushing" | "synced" | "error"; pendingOps: number; updatedAt: number }
  >;
  /** Total bytes uploaded to Swarm this session (tracked by plugin) */
  totalBytesUploaded?: number;
  /** Share documents with another user */
  shareDocuments?: (
    docIds: string[],
    recipientAddress: string,
  ) => Promise<{ success: boolean; shared: number; error?: string }>;
  /** Import documents shared by another user */
  importSharedDocuments?: (
    senderAddress: string,
  ) => Promise<{ success: boolean; imported: string[]; error?: string }>;
  /** Look up a user's public profile */
  lookupUser?: (
    address: string,
  ) => Promise<{ address: string; beeNodePublicKey: string } | null>;
  /** Current Bee node URL */
  beeUrl?: string;
  /** Change Bee node URL and reconnect */
  setBeeUrl?: (url: string) => Promise<void>;
  /** Lightweight stamp refresh — re-reads stamp status without full reconnect */
  refreshStamp?: () => Promise<void>;
  /** Whether SwarmChannel inbox is recovering data from Swarm */
  recovering?: boolean;
  /** Subscribe to plugin events. Returns unsubscribe function. */
  on?: (event: string, handler: (data: Record<string, unknown>) => void) => () => void;
  /** Get detailed node status (mode, peers, reachability, neighborhood) */
  getNodeStatus?: () => Promise<NodeStatus | null>;
  /** Check if content is still retrievable from the Swarm network */
  isContentAvailable?: (reference: string) => Promise<boolean>;
  /** Re-upload content that may no longer be available */
  reuploadContent?: (reference: string) => Promise<void>;
  /** Get per-bucket utilization for the stamp */
  getBucketUtilization?: () => Promise<BucketUtilization | null>;
  /** Fetch all stamps on the Bee node */
  getAllStamps?: () => Promise<BeeStampInfo[]>;
  /** Switch to a different stamp and reconnect */
  switchStamp?: (batchId: string) => Promise<void>;
};

export type NodeStatus = {
  overlay: string;
  beeMode: "light" | "full" | "dev" | "ultra-light" | "unknown";
  isReachable: boolean;
  connectedPeers: number;
  neighborhoodSize: number;
  reserveSize: number;
  pullsyncRate: number;
  storageRadius: number;
};

export type BeeStampInfo = {
  batchID: string;
  usable: boolean;
  depth: number;
  amount: string;
  bucketDepth: number;
  immutableFlag: boolean;
  exists: boolean;
  batchTTL: number;
  utilization: number;
};

export type BucketUtilization = {
  depth: number;
  bucketDepth: number;
  bucketUpperBound: number;
  buckets: Array<{ index: number; collisions: number }>;
  hotBuckets: Array<{ index: number; collisions: number; percentFull: number }>;
};

/** Stamp option presets returned by the API or derived from constants */
export type StampOptions = {
  sizeOptions: Array<{ depth: number; label: string }>;
  durationOptions: Array<{ days: number; label: string; amount: string }>;
  currentDepth: number;
};
