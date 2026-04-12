/**
 * CompositeChannelFactory — Routes channel creation by config.type.
 *
 * Allows multiple channel types (e.g. "gql" and "swarm") to coexist
 * within a single reactor instance. The SyncManager calls
 * factory.instance(config) for each remote; this factory dispatches
 * to the appropriate sub-factory based on config.type.
 */
import type { IChannel, IChannelFactory, ChannelConfig, RemoteFilter, ISyncCursorStorage, IOperationIndex } from "@powerhousedao/reactor";
export declare class CompositeChannelFactory implements IChannelFactory {
    private factories;
    register(type: string, factory: IChannelFactory): void;
    instance(remoteId: string, remoteName: string, config: ChannelConfig, cursorStorage: ISyncCursorStorage, collectionId: string, filter: RemoteFilter, operationIndex: IOperationIndex): IChannel;
}
//# sourceMappingURL=composite-factory.d.ts.map