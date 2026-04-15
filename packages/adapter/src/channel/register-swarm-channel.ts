/**
 * Utility for registering Swarm as a sync channel type on a reactor.
 *
 * The preferred approach is to use createSwarmSyncBuilder() from
 * create-composite-factory.ts with ReactorBuilder.withSync().
 * This function is kept as a runtime utility for edge cases where
 * the factory needs to be replaced after build.
 */
import type { ILogger } from "document-model";
import type {
  IChannelFactory,
  ISyncManager,
} from "@powerhousedao/reactor";
import { CompositeChannelFactory } from "./composite-factory.js";
import { SwarmChannelFactory } from "./swarm-channel-factory.js";

/**
 * Wraps the SyncManager's existing channelFactory with a CompositeChannelFactory
 * that adds Swarm channel support alongside the existing GQL channel.
 *
 * @param syncManager - The ISyncManager from reactorModule.syncModule
 * @param existingFactory - The IChannelFactory from syncModule.channelFactory
 * @param logger - Logger instance
 * @returns The CompositeChannelFactory (for reference)
 */
export function registerSwarmChannel(
  syncManager: ISyncManager,
  existingFactory: IChannelFactory,
  logger: ILogger,
): CompositeChannelFactory {
  const composite = new CompositeChannelFactory();

  // Delegate "gql" (and any other type) to the original factory
  composite.register("gql", existingFactory);

  // Add Swarm channel support
  composite.register("swarm", new SwarmChannelFactory(logger));

  // Replace the factory on the SyncManager instance.
  // channelFactory is `private readonly` in TypeScript but accessible at runtime.
  (syncManager as any).channelFactory = composite;

  logger.info("[SwarmChannel] Registered Swarm channel type on SyncManager");

  return composite;
}
