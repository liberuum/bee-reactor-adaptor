import type { SwarmClient } from "../swarm-client.js";
import type { ChatMessage, ChatHistoryPage } from "./types.js";
/**
 * Derive a deterministic feed topic for chat history.
 * Sorting ensures both parties use the same feed.
 */
export declare function historyTopic(addressA: string, addressB: string): string;
export declare class ChatHistory {
    private readonly client;
    private readonly myAddress;
    constructor(client: SwarmClient, myAddress: string);
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
    writeMessages(peerAddress: string, messages: ChatMessage[], peerBeeNodePubKey: string): Promise<{
        actHistoryRef: string;
        actGranteeRef: string;
    }>;
    /**
     * Read the latest chat history page from a peer's feed.
     *
     * @param peerAddress - Peer's Swarm signer address (feed owner)
     * @param publisherBeeNodePubKey - Peer's Bee node public key (for ACT download)
     * @param actHistoryAddress - ACT history address (from session metadata)
     * @returns The latest message page, or null if no history exists
     */
    readMessages(peerAddress: string, publisherBeeNodePubKey: string, actHistoryAddress: string): Promise<ChatHistoryPage | null>;
}
//# sourceMappingURL=chat-history.d.ts.map