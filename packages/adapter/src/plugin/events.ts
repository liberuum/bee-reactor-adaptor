/**
 * Plugin event system — simple callback-based notifications.
 *
 * Exposes typed event handlers on window.ph.swarm that the Settings UI
 * (or any consumer) can subscribe to. Push-based — no polling needed.
 *
 * Usage from the UI:
 *   const unsub = window.ph.swarm.on("sync:confirmed", (e) => {
 *     showToast(`"${e.docName}" confirmed on Swarm (${e.durationMs}ms)`);
 *   });
 */

export type SwarmEventType =
  | "plugin:ready"
  | "plugin:disconnected"
  | "plugin:retrying"
  | "sync:buffered"
  | "sync:flushing"
  | "sync:confirmed"
  | "sync:error"
  | "sync:all-synced"
  | "recovery:started"
  | "recovery:complete"
  | "stamp:health"
  | "storage:cleared";

export interface SwarmEventData {
  "plugin:ready": { ownerAddress: string; beeUrl: string; isDevMode: boolean };
  "plugin:disconnected": { message: string };
  "plugin:retrying": { beeUrl: string; retryInMs: number };
  "sync:buffered": { docId: string; docName: string; pendingOps: number };
  "sync:flushing": { docId: string; docName: string; opsCount: number };
  "sync:confirmed": { docId: string; docName: string; opsCount: number; reference: string; durationMs: number; chunksTotal: number; chunksSynced: number };
  "sync:error": { docId: string; docName: string; error: string };
  "sync:all-synced": Record<string, never>;
  "recovery:started": { driveCount: number };
  "recovery:complete": { docsRestored: number; drivesRestored: number };
  "stamp:health": { health: string; ttlHuman: string; immutable: boolean; warnings: string[] };
  "storage:cleared": Record<string, never>;
}

type Listener<K extends SwarmEventType> = (data: SwarmEventData[K]) => void;

const listeners = new Map<string, Set<Listener<any>>>();

/**
 * Subscribe to a plugin event. Returns an unsubscribe function.
 */
export function onSwarmEvent<K extends SwarmEventType>(
  event: K,
  listener: Listener<K>,
): () => void {
  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }
  listeners.get(event)!.add(listener);
  return () => { listeners.get(event)?.delete(listener); };
}

/**
 * Emit an event to all subscribers. Called from plugin internals.
 */
export function emitSwarmEvent<K extends SwarmEventType>(
  event: K,
  data: SwarmEventData[K],
): void {
  const set = listeners.get(event);
  if (!set || set.size === 0) return;
  for (const listener of set) {
    try {
      listener(data);
    } catch (err) {
      console.warn(`[SwarmEvents] Listener error for "${event}":`, err);
    }
  }
}

/**
 * Clear all listeners (for cleanup on reconnect/HMR).
 */
export function clearSwarmEventListeners(): void {
  listeners.clear();
}

/**
 * Install the event system on window.ph.swarm.
 * Called from init.ts after plugin startup.
 */
export function installEventHandlers(phSwarm: Record<string, unknown>): void {
  phSwarm.on = onSwarmEvent;
  phSwarm.off = (event: SwarmEventType, listener: Listener<any>) => {
    listeners.get(event)?.delete(listener);
  };
}
