/**
 * Factory helper — creates a CompositeChannelFactory with GQL + Swarm channels.
 *
 * This is the single integration point between the adapter and Connect.
 * Connect's createBrowserReactor() calls this instead of using
 * .withChannelScheme(ChannelScheme.CONNECT).
 *
 * Usage in Connect's reactor.ts:
 *   import { createSwarmSyncBuilder } from "../../../adapter/src/channel/create-composite-factory.js";
 *   const { syncBuilder, registerGqlFactory } = createSwarmSyncBuilder(logger, jwtHandler);
 *   // ... build reactor ...
 *   registerGqlFactory(reactorModule.queue);
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
 * GQL channel is registered via the returned `registerGqlFactory` callback
 * once the queue becomes available after ReactorBuilder.buildModule().
 */
export function createSwarmSyncBuilder(
  logger: ILogger,
  jwtHandler?: JwtHandler,
): {
  syncBuilder: SyncBuilder;
  compositeFactory: CompositeChannelFactory;
  registerGqlFactory: (queue: IQueue) => void;
} {
  const compositeFactory = new CompositeChannelFactory();

  // Swarm channel — always available (no queue dependency)
  compositeFactory.register("swarm", new SwarmChannelFactory(logger));

  // GQL channel is registered lazily after build via registerGqlFactory().
  // The factory's instance() is only called during SyncManager.startup()
  // and .add(), both of which happen after buildModule() completes.
  const registerGqlFactory = (queue: IQueue) => {
    compositeFactory.register(
      "gql",
      new GqlRequestChannelFactory(logger, jwtHandler, queue),
    );
  };

  const syncBuilder = new SyncBuilder().withChannelFactory(compositeFactory);

  return { syncBuilder, compositeFactory, registerGqlFactory };
}
