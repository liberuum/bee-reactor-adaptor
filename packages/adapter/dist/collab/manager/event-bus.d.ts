/**
 * CollabEventBus — fans out `CollabEvent`s to subscribed handlers and
 * isolates each handler's exceptions so a misbehaving UI listener
 * can't break the manager's internal state transitions.
 */
import type { CollabEvent, CollabEventHandler, CollabEventType } from "../types.js";
export declare class CollabEventBus {
    private readonly handlers;
    on(type: CollabEventType | "*", handler: CollabEventHandler): () => void;
    emit(event: CollabEvent): void;
}
//# sourceMappingURL=event-bus.d.ts.map