import { SwarmChannel } from "./swarm-channel.js";
export class SwarmChannelFactory {
    logger;
    constructor(logger) {
        this.logger = logger;
    }
    instance(remoteId, remoteName, config, cursorStorage, collectionId, filter, operationIndex) {
        const params = config.parameters;
        const beeUrl = params.beeUrl;
        if (typeof beeUrl !== "string" || !beeUrl) {
            throw new Error('SwarmChannelFactory requires "beeUrl" parameter in config.parameters');
        }
        const swarmConfig = {
            beeUrl,
            batchId: typeof params.batchId === "string" ? params.batchId : "",
            feedTopicPrefix: typeof params.feedTopicPrefix === "string" ? params.feedTopicPrefix : "ph:v2",
            ownerAddress: typeof params.ownerAddress === "string" ? params.ownerAddress : "",
            pollIntervalMs: typeof params.pollIntervalMs === "number" ? params.pollIntervalMs : 5000,
            collectionId,
            filter,
        };
        return new SwarmChannel(this.logger, remoteId, remoteName, cursorStorage, swarmConfig, operationIndex);
    }
}
//# sourceMappingURL=swarm-channel-factory.js.map