/**
 * Shared mutable state for the Swarm plugin system.
 *
 * All cross-module state lives here so every module can read/write it
 * without circular imports. Status helpers and small utilities included.
 */
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

// ─── Shared State ───────────────────────────────────────────────

export const state = {
  /** Bee node URL (mutable — changed via settings UI) */
  beeUrl: readBeeUrl(),

  // ─── UI cache (populated by populateUiCacheFromDrives) ────
  docToDrive: new Map<string, string>(),
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

// ─── Upload Bytes Tracking ──────────────────────────────────────

/** Track total bytes uploaded to Swarm (persists in sessionStorage for display) */
export function getUploadedBytes(): number {
  try {
    return parseInt(sessionStorage.getItem("__swarm_uploaded_bytes__") ?? "0", 10) || 0;
  } catch { return 0; }
}

