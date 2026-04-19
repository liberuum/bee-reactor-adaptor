/**
 * CollabEventBus — fans out `CollabEvent`s to subscribed handlers and
 * isolates each handler's exceptions so a misbehaving UI listener
 * can't break the manager's internal state transitions.
 */
export class CollabEventBus {
    handlers = new Set();
    on(type, handler) {
        const wrapped = (evt) => {
            if (type === "*" || evt.type === type)
                handler(evt);
        };
        this.handlers.add(wrapped);
        return () => this.handlers.delete(wrapped);
    }
    emit(event) {
        for (const h of this.handlers) {
            try {
                h(event);
            }
            catch (err) {
                console.warn("[CollabManager] event handler threw:", err);
            }
        }
    }
}
//# sourceMappingURL=event-bus.js.map