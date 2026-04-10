/**
 * Re-export from the plugin module.
 *
 * The implementation lives in plugin/ — this file exists so that
 * index.ts can keep its existing import path unchanged:
 *
 *   export { swarmPluginProcessorBuilder } from "./swarm-plugin.js";
 */
export { swarmPluginProcessorBuilder } from "./plugin/init.js";
