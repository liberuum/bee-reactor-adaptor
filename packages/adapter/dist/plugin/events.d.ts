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
export type SwarmEventType = "plugin:ready" | "plugin:disconnected" | "plugin:retrying" | "sync:buffered" | "sync:flushing" | "sync:confirmed" | "sync:error" | "sync:all-synced" | "recovery:started" | "recovery:complete" | "stamp:health" | "storage:cleared";
export interface SwarmEventData {
    "plugin:ready": {
        ownerAddress: string;
        beeUrl: string;
        isDevMode: boolean;
    };
    "plugin:disconnected": {
        message: string;
    };
    "plugin:retrying": {
        beeUrl: string;
        retryInMs: number;
    };
    "sync:buffered": {
        docId: string;
        docName: string;
        pendingOps: number;
    };
    "sync:flushing": {
        docId: string;
        docName: string;
        opsCount: number;
    };
    "sync:confirmed": {
        docId: string;
        docName: string;
        opsCount: number;
        reference: string;
        durationMs: number;
        chunksTotal: number;
        chunksSynced: number;
    };
    "sync:error": {
        docId: string;
        docName: string;
        error: string;
    };
    "sync:all-synced": Record<string, never>;
    "recovery:started": {
        driveCount: number;
    };
    "recovery:complete": {
        docsRestored: number;
        drivesRestored: number;
    };
    "stamp:health": {
        health: string;
        ttlHuman: string;
        immutable: boolean;
        warnings: string[];
    };
    "storage:cleared": Record<string, never>;
}
type Listener<K extends SwarmEventType> = (data: SwarmEventData[K]) => void;
/**
 * Subscribe to a plugin event. Returns an unsubscribe function.
 */
export declare function onSwarmEvent<K extends SwarmEventType>(event: K, listener: Listener<K>): () => void;
/**
 * Emit an event to all subscribers. Called from plugin internals.
 */
export declare function emitSwarmEvent<K extends SwarmEventType>(event: K, data: SwarmEventData[K]): void;
/**
 * Install the event system on window.ph.swarm.
 * Called from init.ts after plugin startup.
 */
export declare function installEventHandlers(phSwarm: Record<string, unknown>): void;
export {};
//# sourceMappingURL=events.d.ts.map