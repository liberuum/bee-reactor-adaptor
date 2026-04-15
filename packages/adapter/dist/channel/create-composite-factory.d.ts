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
import { SyncBuilder, type JwtHandler, type IQueue } from "@powerhousedao/reactor";
import { CompositeChannelFactory } from "./composite-factory.js";
/**
 * Creates a CompositeChannelFactory with Swarm channel support.
 * GQL channel is registered via the returned `registerGqlFactory` callback
 * once the queue becomes available after ReactorBuilder.buildModule().
 */
export declare function createSwarmSyncBuilder(logger: ILogger, jwtHandler?: JwtHandler): {
    syncBuilder: SyncBuilder;
    compositeFactory: CompositeChannelFactory;
    registerGqlFactory: (queue: IQueue) => void;
};
//# sourceMappingURL=create-composite-factory.d.ts.map