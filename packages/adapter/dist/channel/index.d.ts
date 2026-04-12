/**
 * Swarm sync channel — native reactor integration.
 *
 * All channel code lives in this directory (adapter/src/channel/).
 * The existing plugin code (adapter/src/plugin/) is untouched.
 */
export { CompositeChannelFactory } from "./composite-factory.js";
export { SwarmChannel, type SwarmChannelConfig } from "./swarm-channel.js";
export { SwarmChannelFactory } from "./swarm-channel-factory.js";
export { createSwarmSyncBuilder } from "./create-composite-factory.js";
export { registerSwarmChannel } from "./register-swarm-channel.js";
export { ensureDriveInUserManifest, updateDriveManifest, extractDriveInfoFromOps, } from "./manifest-manager.js";
export { addSwarmRemoteForDrive, addSwarmRemotesForAllDrives, type SwarmRemoteConfig } from "./add-swarm-remote.js";
//# sourceMappingURL=index.d.ts.map