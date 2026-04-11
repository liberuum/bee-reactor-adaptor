/**
 * Register Swarm as a sync channel type on an already-built reactor.
 *
 * The ReactorBuilder creates the GqlRequestChannelFactory internally with
 * its own IQueue. We can't inject a CompositeChannelFactory at build time
 * without access to that queue.
 *
 * Solution: After build, we wrap the existing channelFactory in a
 * CompositeChannelFactory that delegates "gql" to the original factory
 * and "swarm" to our SwarmChannelFactory.
 *
 * This is a post-build hook — call it after createBrowserReactor().
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
 * Must be called after the reactor is built — accesses internal SyncManager state.
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
