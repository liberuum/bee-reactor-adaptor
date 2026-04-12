export { createEmptyManifest } from "../types.js";
// ─── Constants ──────────────────────────────────────────────────
const SWARM_BEE_URL_KEY = "swarm:beeUrl";
const SWARM_BEE_URL_DEFAULT = "http://localhost:1633";
// ─── Bee URL ────────────────────────────────────────────────────
function readBeeUrl() {
    if (typeof window !== "undefined") {
        try {
            const saved = localStorage.getItem(SWARM_BEE_URL_KEY);
            if (saved && saved.trim())
                return saved.trim().replace(/\/+$/, "");
        }
        catch { /* localStorage unavailable */ }
    }
    return SWARM_BEE_URL_DEFAULT;
}
export function persistBeeUrl(url) {
    try {
        localStorage.setItem(SWARM_BEE_URL_KEY, url);
    }
    catch { /* */ }
}
// ─── Shared State ───────────────────────────────────────────────
export const state = {
    /** Bee node URL (mutable — changed via settings UI) */
    beeUrl: readBeeUrl(),
    // ─── UI cache (populated by populateUiCacheFromDrives) ────
    docToDrive: new Map(),
    driveNames: new Map(),
    driveManifestCache: new Map(),
    // ─── Hydration drive mapping ───────────────────────────────
    /** local drive ID → Swarm drive ID (set during hydration) */
    localToSwarmDrive: new Map(),
    /** Swarm drive ID → local drive ID (set during hydration) */
    swarmToLocalDrive: new Map(),
};
// ─── Persistent Drive Mapping (localStorage) ──────────────────
const DRIVE_MAP_KEY = "swarm:driveMap";
/** Load drive mapping from localStorage into state */
export function loadDriveMapping() {
    try {
        const raw = localStorage.getItem(DRIVE_MAP_KEY);
        if (!raw)
            return;
        const entries = JSON.parse(raw);
        for (const [local, swarm] of entries) {
            state.localToSwarmDrive.set(local, swarm);
            state.swarmToLocalDrive.set(swarm, local);
        }
        if (entries.length > 0) {
            console.log(`[SwarmPlugin] Loaded ${entries.length} drive mapping(s) from cache`);
        }
    }
    catch { }
}
// ─── UI Status ──────────────────────────────────────────────────
/** Update the swarm status on window.ph.swarm for the settings UI */
export function setSwarmStatus(status, message) {
    const ph = globalThis.window?.ph;
    if (!ph)
        return;
    if (!ph.swarm) {
        ph.swarm = { status, statusMessage: message ?? "", syncStatus: {} };
    }
    else {
        ph.swarm.status = status;
        ph.swarm.statusMessage = message ?? "";
        if (!ph.swarm.syncStatus)
            ph.swarm.syncStatus = {};
    }
}
// ─── Upload Bytes Tracking ──────────────────────────────────────
/** Track total bytes uploaded to Swarm (persists in sessionStorage for display) */
export function getUploadedBytes() {
    try {
        return parseInt(sessionStorage.getItem("__swarm_uploaded_bytes__") ?? "0", 10) || 0;
    }
    catch {
        return 0;
    }
}
//# sourceMappingURL=state.js.map