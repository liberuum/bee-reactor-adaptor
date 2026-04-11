/**
 * SwarmChannelFactory — Creates SwarmChannel instances from ChannelConfig.
 *
 * Registered with CompositeChannelFactory under type "swarm".
 * Extracts Swarm-specific parameters from config.parameters and
 * instantiates SwarmChannel instances.
 */
import type { ILogger } from "document-model";
import type {
  IChannel,
  IChannelFactory,
  ChannelConfig,
  RemoteFilter,
  ISyncCursorStorage,
  IOperationIndex,
} from "@powerhousedao/reactor";
import { SwarmChannel, type SwarmChannelConfig } from "./swarm-channel.js";

export class SwarmChannelFactory implements IChannelFactory {
  private readonly logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  instance(
    remoteId: string,
    remoteName: string,
    config: ChannelConfig,
    cursorStorage: ISyncCursorStorage,
    collectionId: string,
    filter: RemoteFilter,
    operationIndex: IOperationIndex,
  ): IChannel {
    const params = config.parameters;

    const beeUrl = params.beeUrl;
    if (typeof beeUrl !== "string" || !beeUrl) {
      throw new Error(
        'SwarmChannelFactory requires "beeUrl" parameter in config.parameters',
      );
    }

    const swarmConfig: SwarmChannelConfig = {
      beeUrl,
      batchId: typeof params.batchId === "string" ? params.batchId : "",
      feedTopicPrefix: typeof params.feedTopicPrefix === "string" ? params.feedTopicPrefix : "ph:v2",
      ownerAddress: typeof params.ownerAddress === "string" ? params.ownerAddress : "",
      pollIntervalMs: typeof params.pollIntervalMs === "number" ? params.pollIntervalMs : 5000,
      collectionId,
      filter,
    };

    return new SwarmChannel(
      this.logger,
      remoteId,
      remoteName,
      cursorStorage,
      swarmConfig,
      operationIndex,
    );
  }
}
