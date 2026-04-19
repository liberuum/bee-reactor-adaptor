/**
 * CollabEventBus — fans out `CollabEvent`s to subscribed handlers and
 * isolates each handler's exceptions so a misbehaving UI listener
 * can't break the manager's internal state transitions.
 */

import type {
  CollabEvent,
  CollabEventHandler,
  CollabEventType,
} from "../types.js";

export class CollabEventBus {
  private readonly handlers = new Set<CollabEventHandler>();

  on(
    type: CollabEventType | "*",
    handler: CollabEventHandler,
  ): () => void {
    const wrapped: CollabEventHandler = (evt) => {
      if (type === "*" || evt.type === type) handler(evt);
    };
    this.handlers.add(wrapped);
    return () => this.handlers.delete(wrapped);
  }

  emit(event: CollabEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        console.warn("[CollabManager] event handler threw:", err);
      }
    }
  }
}
