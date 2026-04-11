/**
 * CompositeChannelFactory — Routes channel creation by config.type.
 *
 * Allows multiple channel types (e.g. "gql" and "swarm") to coexist
 * within a single reactor instance. The SyncManager calls
 * factory.instance(config) for each remote; this factory dispatches
 * to the appropriate sub-factory based on config.type.
 */
import type {
  IChannel,
  IChannelFactory,
  ChannelConfig,
  RemoteFilter,
  ISyncCursorStorage,
  IOperationIndex,
} from "@powerhousedao/reactor";

export class CompositeChannelFactory implements IChannelFactory {
  private factories = new Map<string, IChannelFactory>();

  register(type: string, factory: IChannelFactory): void {
    this.factories.set(type, factory);
  }

  instance(
    remoteId: string,
    remoteName: string,
    config: ChannelConfig,
    cursorStorage: ISyncCursorStorage,
    collectionId: string,
    filter: RemoteFilter,
    operationIndex: IOperationIndex,
  ): IChannel {
    const factory = this.factories.get(config.type);
    if (!factory) {
      throw new Error(
        `Unknown channel type "${config.type}". ` +
        `Registered types: ${[...this.factories.keys()].join(", ")}`,
      );
    }
    return factory.instance(
      remoteId,
      remoteName,
      config,
      cursorStorage,
      collectionId,
      filter,
      operationIndex,
    );
  }
}
