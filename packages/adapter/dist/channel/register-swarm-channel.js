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
export function registerSwarmChannel(syncManager, existingFactory, logger) {
    const composite = new CompositeChannelFactory();
    // Delegate "gql" (and any other type) to the original factory
    composite.register("gql", existingFactory);
    // Add Swarm channel support
    composite.register("swarm", new SwarmChannelFactory(logger));
    // Replace the factory on the SyncManager instance.
    // channelFactory is `private readonly` in TypeScript but accessible at runtime.
    syncManager.channelFactory = composite;
    logger.info("[SwarmChannel] Registered Swarm channel type on SyncManager");
    return composite;
}
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
export function patchReactorBuilderForSwarm(reactorBuilder, logger) {
    const originalBuild = reactorBuilder.buildModule.bind(reactorBuilder);
    reactorBuilder.buildModule = async function (...args) {
        // Build runs normally — Swarm remotes are cleared from PGlite
        // before build (in createBrowserReactor) so startup won't crash.
        const module = await originalBuild(...args);
        // Register Swarm channel type on the SyncManager.
        // Swarm remotes are added dynamically after plugin:ready.
        const syncModule = module.reactorModule?.syncModule;
        if (syncModule?.syncManager && syncModule?.channelFactory) {
            registerSwarmChannel(syncModule.syncManager, syncModule.channelFactory, logger);
        }
        return module;
    };
}
//# sourceMappingURL=register-swarm-channel.js.map