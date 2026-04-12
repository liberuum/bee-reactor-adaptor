/**
 * Register Swarm as a sync channel type on an already-built reactor.
 *
 * The ReactorBuilder creates the GqlRequestChannelFactory internally with
 * its own IQueue. We can't inject a CompositeChannelFactory at build time
 * without access to that queue.
 *
 * Solution: BEFORE buildModule(), we wrap the factory that will be created.
 * We patch the SyncBuilder's channelFactory so that when startup() recreates
 * persisted remotes, it already knows about the "swarm" type.
 *
 * Called from createBrowserReactor() BEFORE builder.buildModule().
 */
import type { ILogger } from "document-model";
import type { IChannelFactory, ISyncManager } from "@powerhousedao/reactor";
import { CompositeChannelFactory } from "./composite-factory.js";
/**
 * Wraps the SyncManager's existing channelFactory with a CompositeChannelFactory
 * that adds Swarm channel support alongside the existing GQL channel.
 *
 * Can be called either before or after startup — the factory is replaced
 * on the SyncManager instance directly.
 *
 * @param syncManager - The ISyncManager from reactorModule.syncModule
 * @param existingFactory - The IChannelFactory from syncModule.channelFactory
 * @param logger - Logger instance
 * @returns The CompositeChannelFactory (for reference)
 */
export declare function registerSwarmChannel(syncManager: ISyncManager, existingFactory: IChannelFactory, logger: ILogger): CompositeChannelFactory;
/**
 * Patches the ReactorClientBuilder to inject SwarmChannelFactory BEFORE
 * SyncManager.startup() runs. This is critical: persisted Swarm remotes
 * from sync_remotes must be recreatable on page reload.
 *
 * Strategy: intercept the inner ReactorBuilder (accessed via withReactorBuilder)
 * by patching the outer ReactorClientBuilder.buildModule to:
 * 1. Access the inner ReactorBuilder before it builds
 * 2. Patch the inner ReactorBuilder.buildModule to inject our factory
 *    into the SyncManager BEFORE startup() is called
 *
 * Since we can't reliably intercept between build and startup (they're
 * sequential inside the same function), we instead:
 * 1. Let the build + startup run (Swarm remotes may fail during startup)
 * 2. After build, register the Swarm factory
 * 3. Re-register any failed Swarm remotes
 *
 * The startup error for Swarm remotes is caught internally by the
 * SyncManager (each remote's startup is try/caught) — it doesn't
 * crash the entire build.
 */
export declare function patchReactorBuilderForSwarm(reactorBuilder: any, logger: ILogger): void;
//# sourceMappingURL=register-swarm-channel.d.ts.map