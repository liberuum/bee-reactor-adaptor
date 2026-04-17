/**
 * Chat History — ACT-encrypted persistent message log with feed-indexed pagination.
 *
 * Each feed entry is a PAGE: a small batch of messages written together
 * (usually 1-5 messages per batch — flushed after a 3s debounce).
 *
 * Feed indices give us natural pagination:
 *   - Latest page = highest feed index (read via downloadReference())
 *   - Older pages = N-1, N-2, ... (read via downloadReference({ index }))
 *
 * Each user writes their own sent messages to their own feed. To reconstruct
 * a conversation, both peers read both feeds in parallel, merge, dedupe.
 */
import { Topic, FeedIndex } from "@ethersphere/bee-js";
const HISTORY_TOPIC_PREFIX = "ph:v2:chatlog:";
/**
 * Derive a deterministic feed topic for chat history.
 * Sorting ensures both parties use the same topic (but different owners).
 */
export function historyTopic(addressA, addressB) {
    const sorted = [addressA.toLowerCase(), addressB.toLowerCase()].sort();
    return `${HISTORY_TOPIC_PREFIX}${sorted[0]}:${sorted[1]}`;
}
export class ChatHistory {
    client;
    myAddress;
    /** Cached grantee info per peer (create once, reuse for all writes) */
    granteeCache = new Map();
    constructor(client, myAddress) {
        this.client = client;
        this.myAddress = myAddress;
    }
    // ─── Write side ───────────────────────────────────────────────
    /**
     * Write a batch of new messages as a new feed entry.
     * Each call creates a new feed index (one page).
     *
     * @param peerAddress - Peer's Swarm signer address (for topic + grant)
     * @param messages - Batch of new messages to write (usually 1-5)
     * @param peerBeeNodePubKey - Peer's Bee pubkey for ACT grant
     */
    async writePage(peerAddress, messages, peerBeeNodePubKey) {
        if (messages.length === 0)
            return;
        // Ensure grantees exist (cached per peer)
        let grantees = this.granteeCache.get(peerAddress);
        if (!grantees) {
            const myBeeNodePubKey = await this.client.getBeeNodePublicKey();
            const { ref: granteeRef, historyRef: granteeHistRef } = await this.client.createGrantees([peerBeeNodePubKey, myBeeNodePubKey]);
            grantees = { granteeRef, granteeHistRef };
            this.granteeCache.set(peerAddress, grantees);
            await new Promise(r => setTimeout(r, 1100)); // ACT 1s rule
        }
        const page = {
            messages,
            writtenAt: new Date().toISOString(),
        };
        // Upload ACT-protected page
        const { reference } = await this.client.uploadFile(JSON.stringify(page), {
            act: true,
            actHistoryAddress: grantees.granteeHistRef,
            skipEncryption: true,
        });
        // Write as a new feed entry (feed index auto-increments)
        const topic = Topic.fromString(historyTopic(this.myAddress, peerAddress));
        await this.client.writeFeedPayload(topic, reference);
    }
    // ─── Read side ────────────────────────────────────────────────
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
    async loadLatestPages(feedOwner, peerAddress, publisherBeeNodePubKey, pageCount) {
        const topic = Topic.fromString(historyTopic(this.myAddress, peerAddress));
        const ownerNormalized = feedOwner.replace(/^0x/i, "").toLowerCase();
        // Step 1: Get the latest feed index
        const latestIndex = await this.getLatestFeedIndex(topic, ownerNormalized);
        if (latestIndex === null) {
            return { messages: [], cursor: { nextIndex: null } };
        }
        // Step 2: Load N pages going backwards from latestIndex
        return this.loadPages(topic, ownerNormalized, publisherBeeNodePubKey, latestIndex, pageCount);
    }
    /**
     * Load older pages starting from a cursor (continuation from previous load).
     */
    async loadOlderPages(feedOwner, peerAddress, publisherBeeNodePubKey, cursor, pageCount) {
        if (cursor.nextIndex === null) {
            return { messages: [], cursor: { nextIndex: null } };
        }
        const topic = Topic.fromString(historyTopic(this.myAddress, peerAddress));
        const ownerNormalized = feedOwner.replace(/^0x/i, "").toLowerCase();
        return this.loadPages(topic, ownerNormalized, publisherBeeNodePubKey, cursor.nextIndex, pageCount);
    }
    /**
     * Load a full conversation (merge both feeds) starting from latest.
     * Convenience wrapper used on initial load.
     */
    async loadConversationLatest(peerAddress, myBeeNodePubKey, peerBeeNodePubKey, pageCount) {
        const [mine, peer] = await Promise.all([
            this.loadLatestPages(this.myAddress, peerAddress, myBeeNodePubKey, pageCount),
            this.loadLatestPages(peerAddress, peerAddress, peerBeeNodePubKey, pageCount),
        ]);
        const merged = this.mergeAndSort([...mine.messages, ...peer.messages]);
        return {
            messages: merged,
            cursor: { mine: mine.cursor, peer: peer.cursor },
            hasMore: mine.cursor.nextIndex !== null || peer.cursor.nextIndex !== null,
        };
    }
    /**
     * Load more (older) pages from a conversation using a cursor.
     */
    async loadConversationOlder(peerAddress, myBeeNodePubKey, peerBeeNodePubKey, cursor, pageCount) {
        const [mine, peer] = await Promise.all([
            this.loadOlderPages(this.myAddress, peerAddress, myBeeNodePubKey, cursor.mine, pageCount),
            this.loadOlderPages(peerAddress, peerAddress, peerBeeNodePubKey, cursor.peer, pageCount),
        ]);
        const merged = this.mergeAndSort([...mine.messages, ...peer.messages]);
        return {
            messages: merged,
            cursor: { mine: mine.cursor, peer: peer.cursor },
            hasMore: mine.cursor.nextIndex !== null || peer.cursor.nextIndex !== null,
        };
    }
    // ─── Private helpers ──────────────────────────────────────────
    /** Get the latest feed index (returns null if feed doesn't exist) */
    async getLatestFeedIndex(topic, owner) {
        try {
            const reader = this.client.bee.makeFeedReader(topic, owner);
            const result = await reader.downloadReference();
            // result.feedIndex is a FeedIndex (hex string of 8-byte big-endian integer)
            return this.parseFeedIndex(result.feedIndex);
        }
        catch {
            return null;
        }
    }
    /** Load a range of pages going backwards from startIndex */
    async loadPages(topic, owner, publisherBeeNodePubKey, startIndex, pageCount) {
        const reader = this.client.bee.makeFeedReader(topic, owner);
        const messages = [];
        let currentIndex = startIndex;
        let loaded = 0;
        while (loaded < pageCount && currentIndex >= 0) {
            // Two distinct failure modes here — treating them the same way is
            // what caused recovery to stall on bad pages:
            //   1) downloadReference throws → feed boundary reached (no index
            //      at or below currentIndex exists). Correct to break.
            //   2) downloadFile throws → feed index exists but the /bzz chunk
            //      isn't retrievable (sender hasn't propagated, ACT grant
            //      missing, 2.7.x Bee can't fetch yet). Skip the page and keep
            //      walking — older pages may still be retrievable.
            let ref;
            try {
                const feedIndex = FeedIndex.fromBigInt(BigInt(currentIndex));
                const result = await reader.downloadReference({ index: feedIndex });
                ref = result.reference.toHex();
            }
            catch {
                break; // case 1 — feed boundary
            }
            try {
                const data = await this.client.downloadFile(ref, {
                    actPublisher: publisherBeeNodePubKey,
                    skipDecryption: true,
                });
                const page = JSON.parse(new TextDecoder().decode(data));
                if (Array.isArray(page.messages)) {
                    messages.push(...page.messages);
                }
                loaded++;
            }
            catch {
                // case 2 — page unavailable, don't count it but keep walking
            }
            currentIndex--;
        }
        return {
            messages,
            cursor: { nextIndex: currentIndex >= 0 ? currentIndex : null },
        };
    }
    mergeAndSort(messages) {
        const byId = new Map();
        for (const m of messages) {
            if (!byId.has(m.id))
                byId.set(m.id, m);
        }
        return [...byId.values()].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    }
    /** Parse a FeedIndex (hex string) to a number. */
    parseFeedIndex(idx) {
        try {
            if (idx === null || idx === undefined)
                return null;
            // Try toBigInt() method (bee-js FeedIndex)
            if (typeof idx.toBigInt === "function") {
                return Number(idx.toBigInt());
            }
            // Fallback: parse hex string
            if (typeof idx === "string")
                return parseInt(idx, 16);
            if (typeof idx === "number")
                return idx;
            return null;
        }
        catch {
            return null;
        }
    }
}
//# sourceMappingURL=chat-history.js.map