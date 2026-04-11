/**
 * Factory helper — creates a CompositeChannelFactory with GQL + Swarm channels.
 *
 * This is the single integration point between the adapter and Connect.
 * Connect's createBrowserReactor() calls this instead of using
 * .withChannelScheme(ChannelScheme.CONNECT).
 *
 * Usage in Connect's reactor.ts:
 *   import { createSwarmSyncBuilder } from "../../../adapter/src/channel/create-composite-factory.js";
 *   const syncBuilder = createSwarmSyncBuilder(logger, jwtHandler, queue);
 *   new ReactorBuilder().withSync(syncBuilder)
 */
import type { ILogger } from "document-model";
import {
  SyncBuilder,
  GqlRequestChannelFactory,
  type JwtHandler,
  type IQueue,
} from "@powerhousedao/reactor";
import { CompositeChannelFactory } from "./composite-factory.js";
import { SwarmChannelFactory } from "./swarm-channel-factory.js";

/**
 * Creates a CompositeChannelFactory with Swarm channel support.
 * GQL channel is registered lazily when a queue becomes available.
 */
export function createCompositeFactory(logger: ILogger): CompositeChannelFactory {
  const factory = new CompositeChannelFactory();

  // Swarm channel — always available (no queue dependency)
  factory.register("swarm", new SwarmChannelFactory(logger));

  return factory;
}

/**
 * Creates a SyncBuilder with a CompositeChannelFactory that supports
 * both "gql" (Switchboard/Connect cloud) and "swarm" (Bee node) channels.
 *
 * The GQL channel requires a queue instance. If no queue is provided,
 * only the Swarm channel is registered (GQL addRemoteDrive will fail).
 *
 * @param logger - Logger instance
 * @param jwtHandler - JWT handler for GQL authentication (optional)
 * @param queue - Queue instance for the GQL channel (optional)
 */
export function createSwarmSyncBuilder(
  logger: ILogger,
  jwtHandler?: JwtHandler,
  queue?: IQueue,
): SyncBuilder {
  const compositeFactory = createCompositeFactory(logger);

  // GQL channel — only registered when queue is available
  // The queue is created by ReactorBuilder internally.
  // When using .withSync(), the builder still creates the queue
  // and passes it via the channelScheme path. We register GQL
  // unconditionally using a lazy queue that gets set after build.
  if (queue) {
    compositeFactory.register(
      "gql",
      new GqlRequestChannelFactory(logger, jwtHandler, queue),
    );
  }

  return new SyncBuilder().withChannelFactory(compositeFactory);
}
