/**
 * Swarm Connect Plugin Processor
 *
 * Runs in the Connect browser context. Initializes the SwarmConnectPlugin
 * ASYNCHRONOUSLY when the processor factory is registered — does NOT block startup,
 * and does NOT require a drive to exist first.
 *
 * After initialization, subscribes to reactor document changes and uploads
 * operations to Swarm in real-time. On login after a browser wipe, hydrates
 * documents back from Swarm feeds.
 */
import type { ProcessorFactoryBuilder } from "@powerhousedao/reactor";
export declare const swarmPluginProcessorBuilder: ProcessorFactoryBuilder;
//# sourceMappingURL=swarm-plugin.d.ts.map