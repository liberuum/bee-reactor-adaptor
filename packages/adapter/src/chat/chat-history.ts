/**
 * Chat History — ACT-encrypted persistent message log on Swarm feeds.
 *
 * PSS messages are ephemeral (expire with stamp TTL). This module
 * persists messages to a Swarm feed with ACT encryption so both
 * parties can read the history. Uses /bzz for ACT support.
 *
 * Each conversation has its own feed. Messages are stored in pages
 * (newest first). The feed index increments with each page write.
 */
import { Topic } from "@ethersphere/bee-js";
import type { SwarmClient } from "../swarm-client.js";
import type { ChatMessage, ChatHistoryPage } from "./types.js";

const HISTORY_TOPIC_PREFIX = "ph:v2:chatlog:";

/**
 * Derive a deterministic feed topic for chat history.
 * Sorting ensures both parties use the same feed.
 */
export function historyTopic(addressA: string, addressB: string): string {
  const sorted = [addressA.toLowerCase(), addressB.toLowerCase()].sort();
  return `${HISTORY_TOPIC_PREFIX}${sorted[0]}:${sorted[1]}`;
}

export class ChatHistory {
  constructor(
    private readonly client: SwarmClient,
    private readonly myAddress: string,
  ) {}

  /**
   * Persist a batch of messages to the chat history feed.
   *
   * Messages are uploaded with ACT protection and both parties'
   * Bee node public keys as grantees. The feed is owned by the
   * caller (each user writes their own messages to the feed).
   *
   * @param peerAddress - Peer's Swarm signer address
   * @param messages - Messages to persist (newest last)
   * @param peerBeeNodePubKey - Peer's Bee node public key for ACT grant
   * @returns ACT metadata for the written page
   */
  async writeMessages(
    peerAddress: string,
    messages: ChatMessage[],
    peerBeeNodePubKey: string,
  ): Promise<{ actHistoryRef: string; actGranteeRef: string }> {
    const myBeeNodePubKey = await this.client.getBeeNodePublicKey();

    // Create grantee list with both parties (1-second ACT rule respected)
    const { ref: granteeRef, historyRef: granteeHistRef } =
      await this.client.createGrantees([peerBeeNodePubKey, myBeeNodePubKey]);

    // Wait for ACT 1-second rule
    await new Promise(r => setTimeout(r, 1100));

    // Upload message page with ACT, chained to grantee history
    const page: ChatHistoryPage = {
      messages,
      page: 0,
      hasMore: false,
    };

    const { reference, historyAddress } = await this.client.uploadFile(
      JSON.stringify(page),
      {
        act: true,
        actHistoryAddress: granteeHistRef,
        skipEncryption: true, // ACT handles encryption
      },
    );

    // Write to the feed so the peer can discover it
    const topic = Topic.fromString(historyTopic(this.myAddress, peerAddress));
    await this.client.writeFeedPayload(topic, reference);

    return {
      actHistoryRef: historyAddress ?? granteeHistRef,
      actGranteeRef: granteeRef,
    };
  }

  /**
   * Read the latest chat history page from a peer's feed.
   *
   * @param peerAddress - Peer's Swarm signer address (feed owner)
   * @param publisherBeeNodePubKey - Peer's Bee node public key (for ACT download)
   * @param actHistoryAddress - ACT history address (from session metadata)
   * @returns The latest message page, or null if no history exists
   */
  async readMessages(
    peerAddress: string,
    publisherBeeNodePubKey: string,
    actHistoryAddress: string,
  ): Promise<ChatHistoryPage | null> {
    const topic = historyTopic(this.myAddress, peerAddress);

    try {
      // Read the feed to get the latest history page
      const topic = Topic.fromString(historyTopic(this.myAddress, peerAddress));
      const page = await this.client.readFeedJson<ChatHistoryPage>(
        topic,
        peerAddress.replace(/^0x/i, "").toLowerCase(),
        { skipDecryption: true },
      );

      // TODO: when ACT feed reads are supported, download with:
      // actPublisher: publisherBeeNodePubKey, actHistoryAddress
      return page;
    } catch {
      return null;
    }
  }
}
