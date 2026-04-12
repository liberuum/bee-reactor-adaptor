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
const listeners = new Map();
/**
 * Subscribe to a plugin event. Returns an unsubscribe function.
 */
export function onSwarmEvent(event, listener) {
    if (!listeners.has(event)) {
        listeners.set(event, new Set());
    }
    listeners.get(event).add(listener);
    return () => { listeners.get(event)?.delete(listener); };
}
/**
 * Emit an event to all subscribers. Called from plugin internals.
 */
export function emitSwarmEvent(event, data) {
    const set = listeners.get(event);
    if (!set || set.size === 0)
        return;
    for (const listener of set) {
        try {
            listener(data);
        }
        catch (err) {
            console.warn(`[SwarmEvents] Listener error for "${event}":`, err);
        }
    }
}
/**
 * Install the event system on window.ph.swarm.
 * Called from init.ts after plugin startup.
 */
export function installEventHandlers(phSwarm) {
    phSwarm.on = onSwarmEvent;
    phSwarm.off = (event, listener) => {
        listeners.get(event)?.delete(listener);
    };
}
//# sourceMappingURL=events.js.map