/**
 * SwarmChannelFactory — Creates SwarmChannel instances from ChannelConfig.
 *
 * Registered with CompositeChannelFactory under type "swarm".
 * Extracts Swarm-specific parameters from config.parameters and
 * instantiates SwarmChannel instances.
 */
import type { ILogger } from "document-model";
import type { IChannel, IChannelFactory, ChannelConfig, RemoteFilter, ISyncCursorStorage, IOperationIndex } from "@powerhousedao/reactor";
export declare class SwarmChannelFactory implements IChannelFactory {
    private readonly logger;
    constructor(logger: ILogger);
    instance(remoteId: string, remoteName: string, config: ChannelConfig, cursorStorage: ISyncCursorStorage, collectionId: string, filter: RemoteFilter, operationIndex: IOperationIndex): IChannel;
}
//# sourceMappingURL=swarm-channel-factory.d.ts.map