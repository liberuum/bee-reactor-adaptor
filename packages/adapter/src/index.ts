export { BeeReactorAdapter } from "./bee-reactor-adapter.js";
export { SwarmClient } from "./swarm-client.js";
export { StampManager, getBzzUsdPrice } from "./stamp-manager.js";
export { ShareManager, deriveShareKey } from "./share-manager.js";
export { SwarmOperationStore } from "./swarm-operation-store.js";
export { SwarmKeyframeStore } from "./swarm-keyframe-store.js";
export { SwarmHydrator } from "./swarm-hydrator.js";
export { SwarmSyncReadModel } from "./swarm-sync-read-model.js";
export { hexToBytes, bytesToHex, concatBytes } from "./bytes-utils.js";

export type {
  BeeAdapterConfig,
  SwarmDocumentManifest,
  SwarmUserManifest,
  UserDocumentEntry,
  UserDriveEntry,
  UserStampEntry,
  StampStatus,
  OperationBatchEntry,
  KeyframeEntry,
  RetryTask,
  SwarmPublicProfile,
  SwarmDriveManifest,
  DriveDocumentEntry,
  DriveFolderEntry,
  ShareManifest,
  SharedDocumentEntry,
} from "./types.js";
export { createEmptyManifest } from "./types.js";

export type {
  Action,
  Operation,
  OperationContext,
  OperationWithContext,
  AtomicTxn,
  IOperationStore,
  OperationFilter,
  PagingOptions,
  PagedResults,
  DocumentRevisions,
} from "./swarm-operation-store.js";
export type { IKeyframeStore } from "./swarm-keyframe-store.js";

export type { HydrationResult } from "./swarm-hydrator.js";

export { SwarmConnectPlugin } from "./connect-plugin.js";
export {
  encrypt,
  decrypt,
  isEncrypted,
  encryptJSON,
  decryptJSON,
} from "./swarm-crypto.js";
export {
  getOrDeriveSwarmKey,
  requestSwarmKeyFromWallet,
  loadCachedSwarmKey,
  cacheSwarmKey,
  clearCachedSwarmKey,
  buildSignMessage,
  deriveSwarmKey,
} from "./wallet-signer.js";
export type { SwarmSignerEntry, EthereumProvider } from "./wallet-signer.js";
export { swarmPluginProcessorBuilder } from "./swarm-plugin.js";
export { initSwarmPlugin } from "./plugin/init.js";
export { onSwarmEvent, emitSwarmEvent } from "./plugin/events.js";
export type { SwarmEventType, SwarmEventData } from "./plugin/events.js";
export { buildFolderTree } from "./folder-tree.js";
export type { FolderEntry, DocEntry, TreeFolder } from "./folder-tree.js";
export type { ReactorClient } from "./plugin/state.js";
