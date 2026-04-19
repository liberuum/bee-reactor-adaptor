/**
 * Module-private constants for the collab manager. Kept separate from
 * `../types.ts` so consumer code outside the manager folder doesn't
 * accidentally reach in.
 */
/** localStorage key for the entire summaries list (JSON-encoded). */
export declare const LS_SUMMARIES_KEY = "swarm:collabs";
/** Prefix for per-(collab, peer, doc) feed cursor keys. */
export declare const LS_PEER_CURSOR_PREFIX = "swarm:collabPeerCursor:";
/** Poll loop tick interval (ms) — GSOC pings are the primary real-time
 *  path, so the poll is a safety net + recovery path for missed pings. */
export declare const POLL_INTERVAL_MS = 5000;
/** Initial poll kick-off delay after boot (ms) — gives window.ph and
 *  outbound GSOC subscriptions a moment to settle before we start
 *  hitting peer feeds. */
export declare const POLL_WARMUP_MS = 1500;
/**
 * GSOC identifier for op-committed pings. Namespaced under
 * "collab-notify" so chat's GSOC subscription doesn't see our traffic
 * (and vice versa).
 */
export declare function collabGsocIdentifier(senderAddress: string, collabId: string): string;
//# sourceMappingURL=constants.d.ts.map