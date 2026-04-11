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
 * Can be called either before or after startup — the factory is replaced
 * on the SyncManager instance directly.
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

/**
 * Pre-build hook: patches the ReactorBuilder so that the channelFactory
 * created internally during build() is automatically wrapped in a
 * CompositeChannelFactory before syncManager.startup() runs.
 *
 * This ensures persisted Swarm remotes can be recreated on restart.
 *
 * Usage:
 *   patchReactorBuilderForSwarm(reactorBuilder, logger);
 *   const module = await builder.buildModule(); // startup uses composite
 */
export function patchReactorBuilderForSwarm(
  reactorBuilder: any,
  logger: ILogger,
): void {
  const originalBuild = reactorBuilder.buildModule.bind(reactorBuilder);

  // Override buildModule to intercept after internal build but before returning
  reactorBuilder.buildModule = async function (...args: any[]) {
    const module = await originalBuild(...args);

    // Patch the syncModule's channelFactory before startup() is called
    // Actually, startup() is called inside buildModule. So we need to
    // patch the channelFactory on the already-started syncManager.
    // The persisted "swarm" remote will have failed during startup.
    // We re-register it after patching.
    const syncModule = module.reactorModule?.syncModule;
    if (syncModule?.syncManager && syncModule?.channelFactory) {
      registerSwarmChannel(syncModule.syncManager, syncModule.channelFactory, logger);

      // Re-add any Swarm remotes that failed during startup
      // (they were persisted but the factory didn't know "swarm" type yet)
      try {
        const storage = syncModule.remoteStorage;
        if (storage) {
          const allRemotes = await storage.list();
          for (const remote of allRemotes) {
            if (remote.channelConfig?.type === "swarm") {
              // Check if it's already active
              try {
                syncModule.syncManager.getByName(remote.name);
                // Already active — skip
              } catch {
                // Not active — it failed during startup. Re-add it.
                logger.info(`[SwarmChannel] Re-registering persisted remote "${remote.name}"`);
                try {
                  await syncModule.syncManager.add(
                    remote.name,
                    remote.collectionId,
                    remote.channelConfig,
                    remote.filter,
                    remote.options,
                    remote.id,
                  );
                } catch (err) {
                  logger.warn(`[SwarmChannel] Failed to re-register "${remote.name}":`, err);
                }
              }
            }
          }
        }
      } catch (err) {
        logger.warn("[SwarmChannel] Failed to check persisted remotes:", err);
      }
    }

    return module;
  };
}
