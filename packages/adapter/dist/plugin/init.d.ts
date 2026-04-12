/**
 * Swarm Connect Plugin — Orchestrator
 *
 * Runs in the Connect browser context. Initializes the SwarmConnectPlugin
 * ASYNCHRONOUSLY — connects to Bee node, derives wallet key, starts sync.
 *
 * Sync is handled by SwarmChannel (native reactor IChannel).
 * This module handles: Bee detection, stamp selection, wallet key,
 * sharing, and UI cache population.
 */
import type { ProcessorFactoryBuilder } from "@powerhousedao/reactor";
export declare const swarmPluginProcessorBuilder: ProcessorFactoryBuilder;
export declare function initSwarmPlugin(): Promise<void>;
//# sourceMappingURL=init.d.ts.map