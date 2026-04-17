import type { SwarmClient } from "../swarm-client.js";
import type { ChatMessage } from "./types.js";
/**
 * Derive a deterministic feed topic for chat history.
 * Sorting ensures both parties use the same topic (but different owners).
 */
export declare function historyTopic(addressA: string, addressB: string, chapter?: number): string;
export declare function getMyChatChapter(): number;
export declare function bumpMyChatChapter(): number;
export declare function getPeerChatChapter(peerAddress: string): number;
/** Record a chapter we learned from an incoming PSS message. Only ever
 *  increases — we never move peer's chapter backwards. */
export declare function recordPeerChatChapter(peerAddress: string, chapter: number): void;
/** Cursor state for backward pagination per feed owner */
export interface FeedCursor {
    /** Next feed index to load (decrements on each load). null = no more */
    nextIndex: number | null;
}
/** Combined cursor for a conversation — tracks both feeds */
export interface HistoryCursor {
    mine: FeedCursor;
    peer: FeedCursor;
}
export interface LoadedHistory {
    messages: ChatMessage[];
    cursor: HistoryCursor;
    /** true if at least one feed has more pages to load */
    hasMore: boolean;
}
export declare class ChatHistory {
    private readonly client;
    private readonly myAddress;
    /** Cached grantee info per peer (create once, reuse for all writes) */
    private granteeCache;
    constructor(client: SwarmClient, myAddress: string);
    /**
     * Write a batch of new messages as a new feed entry.
     * Each call creates a new feed index (one page).
     *
     * @param peerAddress - Peer's Swarm signer address (for topic + grant)
     * @param messages - Batch of new messages to write (usually 1-5)
     * @param peerBeeNodePubKey - Peer's Bee pubkey for ACT grant
     */
    writePage(peerAddress: string, messages: ChatMessage[], peerBeeNodePubKey: string): Promise<void>;
    /**
     * Load the latest N pages from a feed owner.
     *
     * The feed TOPIC is always the sorted-pair topic derived from (my, peer) —
     * symmetric, same on both sides. Only the feed OWNER differs: my own feed
     * is owned by me (stores messages I sent), peer's feed is owned by peer
     * (stores messages they sent). A previous version of this function used
     * `historyTopic(myAddress, feedOwner)` which produced a self-self topic
     * when reading my own feed, so recovery always 404'd on it — writes went
     * to the pair topic, reads looked up a different topic that never existed.
     */
    loadLatestPages(feedOwner: string, peerAddress: string, publisherBeeNodePubKey: string, pageCount: number): Promise<{
        messages: ChatMessage[];
        cursor: FeedCursor;
    }>;
    /**
     * Load older pages starting from a cursor (continuation from previous load).
     */
    loadOlderPages(feedOwner: string, peerAddress: string, publisherBeeNodePubKey: string, cursor: FeedCursor, pageCount: number): Promise<{
        messages: ChatMessage[];
        cursor: FeedCursor;
    }>;
    /**
     * Load a full conversation (merge both feeds) starting from latest.
     * Convenience wrapper used on initial load.
     */
    loadConversationLatest(peerAddress: string, myBeeNodePubKey: string, peerBeeNodePubKey: string, pageCount: number): Promise<LoadedHistory>;
    /**
     * Load more (older) pages from a conversation using a cursor.
     */
    loadConversationOlder(peerAddress: string, myBeeNodePubKey: string, peerBeeNodePubKey: string, cursor: HistoryCursor, pageCount: number): Promise<LoadedHistory>;
    /** Get the latest feed index (returns null if feed doesn't exist) */
    private getLatestFeedIndex;
    /** Load a range of pages going backwards from startIndex */
    private loadPages;
    private mergeAndSort;
    /** Parse a FeedIndex (hex string) to a number. */
    private parseFeedIndex;
}
//# sourceMappingURL=chat-history.d.ts.map