/**
 * Shared mutable state for the Swarm plugin system.
 *
 * All cross-module state lives here so every module can read/write it
 * without circular imports. Status helpers and small utilities included.
 */
import type { SwarmClient } from "../swarm-client.js";
import type { SwarmDriveManifest } from "../types.js";
export { createEmptyManifest } from "../types.js";

// ─── Reactor Client Interface ──────────────────────────────────
// Minimal type for the Connect reactor client used across plugin modules.
// Replaces `any` for compile-time safety on method calls.

/**
 * Minimal interface for the Connect reactor client.
 *
 * The actual ReactorClient from @powerhousedao/reactor has a richer API,
 * but these are the methods the plugin modules use. Return types are `any`
 * because the reactor's response shapes vary by document type and version.
 */
export interface ReactorClient {
  get(documentId: string): Promise<any>;
  getDrives(): Promise<any[]>;
  getChildren(driveId: string): Promise<any>;
  getOperations(documentId: string): Promise<any>;
  execute(documentId: string, branch: string, actions: any[]): Promise<any>;
  createDocumentInDrive(driveId: string, doc: any): Promise<any>;
  getDocumentModelModule?(documentType: string): Promise<any>;
  subscribe?(filter: Record<string, unknown>, handler: (event: any) => void): (() => void) | undefined;
}

// ─── Constants ──────────────────────────────────────────────────

const SWARM_BEE_URL_KEY = "swarm:beeUrl";
const SWARM_BEE_URL_DEFAULT = "http://localhost:1633";

export const DOCUMENT_MANIFEST_FLUSH_DELAY_MS = 3000;
export const MAX_CONCURRENT_FLUSHES = 5;
export const MANIFEST_FLUSH_DELAY_MS = 3000;
export const DRIVE_MANIFEST_FLUSH_DELAY_MS = 3000;

// ─── Bee URL ────────────────────────────────────────────────────

function readBeeUrl(): string {
  if (typeof window !== "undefined") {
    try {
      const saved = localStorage.getItem(SWARM_BEE_URL_KEY);
      if (saved && saved.trim()) return saved.trim().replace(/\/+$/, "");
    } catch { /* localStorage unavailable */ }
  }
  return SWARM_BEE_URL_DEFAULT;
}

export function persistBeeUrl(url: string): void {
  try { localStorage.setItem(SWARM_BEE_URL_KEY, url); } catch { /* */ }
}

// ─── Type Definitions ───────────────────────────────────────────

/** Flush metadata captured during sync, consumed by flushDocumentManifest */
export interface FlushMeta {
  swarmClient: SwarmClient;
  reactorClient: any;
  ownerAddress: string;
  docType: string;
  docName: string;
  driveId: string;
}

/** Single operation buffered for upload */
export interface PendingOp {
  index: number;
  action: unknown;
  hash?: string;
  timestampUtcMs?: string;
  id?: string;
}

// ─── Shared State ───────────────────────────────────────────────

export const state = {
  /** Bee node URL (mutable — changed via settings UI) */
  beeUrl: readBeeUrl(),

  // ─── Sync tracking ─────────────────────────────────────────
  syncPaused: false,
  lastSeenDriveId: "",
  hydrationRan: getHydrationRanStorage(),
  syncedRevisions: new Map<string, number>(),
  docToDrive: new Map<string, string>(),
  recoveringDocs: new Set<string>(),
  pendingSyncs: new Map<string, Promise<void>>(),
  needsResync: new Set<string>(),

  // ─── Document manifest flush ───────────────────────────────
  pendingManifests: new Map<string, any>(),
  docManifestTimers: new Map<string, ReturnType<typeof setTimeout>>(),
  pendingOps: new Map<string, PendingOp[]>(),
  pendingFlushMeta: new Map<string, FlushMeta>(),
  activeFlushCount: 0,
  flushQueue: [] as string[],

  // ─── User manifest flush ───────────────────────────────────
  pendingManifestDriveUpdates: new Map<string, { driveName: string }>(),
  manifestFlushTimer: null as ReturnType<typeof setTimeout> | null,
  manifestFlushInProgress: null as Promise<void> | null,
  manifestFlushGeneration: 0,

  // ─── Drive manifest ────────────────────────────────────────
  pendingDriveUpdates: new Map<string, Map<string, { docType: string; docName: string }>>(),
  driveManifestTimers: new Map<string, ReturnType<typeof setTimeout>>(),
  driveManifestFlushInProgress: new Map<string, Promise<void>>(),
  driveNames: new Map<string, string>(),
  driveManifestCache: new Map<string, SwarmDriveManifest>(),

  // ─── Hydration drive mapping ───────────────────────────────
  /** local drive ID → Swarm drive ID (set during hydration) */
  localToSwarmDrive: new Map<string, string>(),
  /** Swarm drive ID → local drive ID (set during hydration) */
  swarmToLocalDrive: new Map<string, string>(),
};

// ─── Persistent Drive Mapping (localStorage) ──────────────────

const DRIVE_MAP_KEY = "swarm:driveMap";

/** Persist the swarm↔local drive mapping to localStorage */
export function persistDriveMapping(): void {
  const entries: Array<[string, string]> = [];
  for (const [local, swarm] of state.localToSwarmDrive) {
    entries.push([local, swarm]);
  }
  try { localStorage.setItem(DRIVE_MAP_KEY, JSON.stringify(entries)); } catch {}
}

/** Load drive mapping from localStorage into state */
export function loadDriveMapping(): void {
  try {
    const raw = localStorage.getItem(DRIVE_MAP_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw) as Array<[string, string]>;
    for (const [local, swarm] of entries) {
      state.localToSwarmDrive.set(local, swarm);
      state.swarmToLocalDrive.set(swarm, local);
    }
    if (entries.length > 0) {
      console.log(`[SwarmPlugin] Loaded ${entries.length} drive mapping(s) from cache`);
    }
  } catch {}
}

/** Register a swarm↔local drive mapping and persist it */
export function registerDriveMapping(localId: string, swarmId: string): void {
  state.localToSwarmDrive.set(localId, swarmId);
  state.swarmToLocalDrive.set(swarmId, localId);
  persistDriveMapping();
}

// ─── UI Status ──────────────────────────────────────────────────

/** Update the swarm status on window.ph.swarm for the settings UI */
export function setSwarmStatus(status: string, message?: string): void {
  const ph = (globalThis as any).window?.ph;
  if (!ph) return;
  if (!ph.swarm) {
    ph.swarm = { status, statusMessage: message ?? "", syncStatus: {} };
  } else {
    ph.swarm.status = status;
    ph.swarm.statusMessage = message ?? "";
    if (!ph.swarm.syncStatus) ph.swarm.syncStatus = {};
  }
}

/** Update per-document sync status on window.ph.swarm.syncStatus */
export function setDocSyncStatus(
  docId: string,
  syncState: "buffered" | "flushing" | "synced" | "error",
  pendingOpsCount?: number,
): void {
  const ph = (globalThis as any).window?.ph;
  if (!ph?.swarm) return;
  if (!ph.swarm.syncStatus) ph.swarm.syncStatus = {};
  ph.swarm.syncStatus[docId] = {
    state: syncState,
    pendingOps: pendingOpsCount ?? 0,
    updatedAt: Date.now(),
  };
}

// ─── Upload Bytes Tracking ──────────────────────────────────────

/** Track total bytes uploaded to Swarm (persists in sessionStorage for display) */
export function getUploadedBytes(): number {
  try {
    return parseInt(sessionStorage.getItem("__swarm_uploaded_bytes__") ?? "0", 10) || 0;
  } catch { return 0; }
}

export function addUploadedBytes(bytes: number): void {
  const total = getUploadedBytes() + bytes;
  try { sessionStorage.setItem("__swarm_uploaded_bytes__", String(total)); } catch {}
  const ph = (globalThis as any).window?.ph;
  if (ph?.swarm) ph.swarm.totalBytesUploaded = total;
}

export function resetUploadedBytes(): void {
  try { sessionStorage.removeItem("__swarm_uploaded_bytes__"); } catch {}
}

// ─── Hydration Flag (sessionStorage-backed) ─────────────────────

/**
 * Prevents hydration from running multiple times (HMR resets module state).
 * Use sessionStorage so it persists across HMR but resets on new tab.
 */
function getHydrationRanStorage(): boolean {
  try { return sessionStorage.getItem("__swarm_hydration_ran__") === "1"; } catch { return false; }
}

export function setHydrationRan(val: boolean): void {
  state.hydrationRan = val;
  try {
    if (val) sessionStorage.setItem("__swarm_hydration_ran__", "1");
    else sessionStorage.removeItem("__swarm_hydration_ran__");
  } catch {}
}

// ─── Utilities ──────────────────────────────────────────────────

/**
 * Find which local drive contains a document.
 *
 * The reactor's indexer often fails to process ADD_RELATIONSHIP because
 * JOB_WRITE_READY consistently fails for ADD_FILE operations. This means
 * both getChildren() and state.global.nodes are unreliable shortly after
 * document creation. However, the ADD_FILE operation IS committed to PGlite.
 *
 * Strategy (in order of reliability):
 * 1. getChildren — works if the indexer processed it
 * 2. Drive state.global.nodes — how Connect does it
 * 3. lastSeenDriveId — fallback from subscriber
 */
export async function findParentDrive(
  reactorClient: ReactorClient,
  docId: string,
): Promise<string | null> {
  try {
    const drives = await reactorClient.getDrives();
    if (!drives || drives.length === 0) return null;

    // Strategy 1: getChildren (fast path)
    for (const drive of drives) {
      const driveId = drive?.id ?? drive;
      try {
        const children = await reactorClient.getChildren(driveId);
        const childResults = children?.results ?? children ?? [];
        for (const child of childResults) {
          const childId = typeof child === "string" ? child : child?.header?.id ?? child?.id;
          if (childId === docId) return driveId;
        }
      } catch { /* not accessible */ }
    }

    // Strategy 2: drive.state.global.nodes
    for (const drive of drives) {
      const driveId = drive?.id ?? drive;
      try {
        const driveDoc = await reactorClient.get(driveId);
        const nodes = driveDoc?.state?.global?.nodes;
        if (Array.isArray(nodes)) {
          for (const node of nodes) {
            if (node?.id === docId) return driveId;
          }
        }
      } catch { /* not accessible */ }
    }

    // Strategy 3: fallback
    if (state.lastSeenDriveId) return state.lastSeenDriveId;

    return null;
  } catch { /* no drives */ }
  return null;
}
