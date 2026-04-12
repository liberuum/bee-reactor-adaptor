export class CompositeChannelFactory {
    factories = new Map();
    register(type, factory) {
        this.factories.set(type, factory);
    }
    instance(remoteId, remoteName, config, cursorStorage, collectionId, filter, operationIndex) {
        const factory = this.factories.get(config.type);
        if (!factory) {
            throw new Error(`Unknown channel type "${config.type}". ` +
                `Registered types: ${[...this.factories.keys()].join(", ")}`);
        }
        return factory.instance(remoteId, remoteName, config, cursorStorage, collectionId, filter, operationIndex);
    }
}
//# sourceMappingURL=composite-factory.js.map