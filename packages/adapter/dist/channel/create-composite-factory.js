import { SyncBuilder, GqlRequestChannelFactory, } from "@powerhousedao/reactor";
import { CompositeChannelFactory } from "./composite-factory.js";
import { SwarmChannelFactory } from "./swarm-channel-factory.js";
/**
 * Creates a CompositeChannelFactory with Swarm channel support.
 * GQL channel is registered via the returned `registerGqlFactory` callback
 * once the queue becomes available after ReactorBuilder.buildModule().
 */
export function createSwarmSyncBuilder(logger, jwtHandler) {
    const compositeFactory = new CompositeChannelFactory();
    // Swarm channel — always available (no queue dependency)
    compositeFactory.register("swarm", new SwarmChannelFactory(logger));
    // GQL channel is registered lazily after build via registerGqlFactory().
    // The factory's instance() is only called during SyncManager.startup()
    // and .add(), both of which happen after buildModule() completes.
    const registerGqlFactory = (queue) => {
        compositeFactory.register("gql", new GqlRequestChannelFactory(logger, jwtHandler, queue));
    };
    const syncBuilder = new SyncBuilder().withChannelFactory(compositeFactory);
    return { syncBuilder, compositeFactory, registerGqlFactory };
}
//# sourceMappingURL=create-composite-factory.js.map