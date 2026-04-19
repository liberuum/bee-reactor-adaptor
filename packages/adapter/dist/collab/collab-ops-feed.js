/**
 * CollabOpsFeed — ACT-protected per-peer operation feed for live collaboration.
 *
 * Each participant writes their OWN ops to their OWN feed. The feed topic is
 * scoped by collabId + driveId + docId; the feed OWNER is the writer's Swarm
 * signer address. Every other participant's Bee node pubkey is an ACT grantee
 * so peers can decrypt each other's ops (the inviter's non-participant
 * personal feeds stay wallet-key encrypted and untouched).
 *
 * Feed layout (one append per op batch):
 *
 *   feed index 0 ─┐
 *   feed index 1 ─┼─► 32-byte ref to a 64-byte wrapper chunk on /bytes
 *   feed index 2 ─┘        │
 *                          ├── bytes 0..31: actRef     (ACT-protected batch payload on /bzz)
 *                          └── bytes 32..63: actHist   (ACT chain head)
 *
 * The wrapper chunk mirrors the pattern used by chat-history.ts so peers can
 * reconstruct the full ACT decryption context from the feed alone, with no
 * side-channel state.
 *
 * Batch payload format (after ACT decrypt):
 *   { opsJson: string, startIndex: number, endIndex: number, scope: string, branch: string, timestamp: string }
 */
import { Topic, FeedIndex } from "@ethersphere/bee-js";
import { collabDocOpsTopic, collabDriveOpsTopic } from "./types.js";
import { WRAPPER_BYTES, parseFeedIndex, hexToBytes32, bytes32ToHex } from "./feed-bytes.js";
export class CollabOpsFeed {
    client;
    /** Last index we wrote per topic. Same staleness workaround as the
     *  manifest feed — bee-js's auto-pick pre-read can be stale on public
     *  nodes, so we track indices ourselves and write at an explicit index. */
    lastWrittenIndex = new Map();
    /** Per-topic in-flight append — serializes concurrent appendBatch
     *  calls for the same topic. Without this, two parallel calls both
     *  see lastWrittenIndex as undefined, both do the pre-read, both
     *  derive the same nextIndex, and both write to the same feed slot
     *  (second overwrites first). */
    appendInFlight = new Map();
    constructor(client) {
        this.client = client;
    }
    // ─── Topics ────────────────────────────────────────────────────
    /**
     * Resolve the Swarm feed topic for a per-peer collab ops feed.
     *
     * Note: production callers always pass `documentId`. Drive-level
     * ops are stored under the doc-scoped topic with `docId === driveId`
     * (see `handleLocalPush` + `pollSummary`'s `docIds.unshift(driveId)`).
     * The `documentId`-omitted branch is retained for future flexibility
     * and is exercised by the unit test.
     */
    static topicFor(collabId, driveId, documentId) {
        const raw = documentId
            ? collabDocOpsTopic(collabId, driveId, documentId)
            : collabDriveOpsTopic(collabId, driveId);
        return Topic.fromString(raw);
    }
    // ─── Write side ────────────────────────────────────────────────
    /**
     * Append a batch of ops to this writer's per-collab feed.
     *
     * @param granteeHistRef ACT grantee-chain head that the caller has
     *        already created (via SwarmClient.createGrantees). The caller
     *        (CollabManager) owns this lifecycle so revocation can rotate
     *        the chain without losing track of it.
     */
    async appendBatch(collabId, driveId, documentId, batch, granteeHistRef) {
        const topic = CollabOpsFeed.topicFor(collabId, driveId, documentId);
        const topicHex = topic.toHex();
        // Per-topic serialization: chain on any in-flight append for this
        // topic. This protects the lastWrittenIndex cache + the feed write
        // from TOCTOU races when two handleLocalPush calls fire in parallel
        // for the same doc.
        const prev = this.appendInFlight.get(topicHex) ?? Promise.resolve();
        const next = prev.then(() => this.appendBatchLocked(topic, topicHex, batch, granteeHistRef), () => this.appendBatchLocked(topic, topicHex, batch, granteeHistRef));
        this.appendInFlight.set(topicHex, next);
        try {
            return await next;
        }
        finally {
            if (this.appendInFlight.get(topicHex) === next) {
                this.appendInFlight.delete(topicHex);
            }
        }
    }
    async appendBatchLocked(topic, topicHex, batch, granteeHistRef) {
        // Upload ACT-protected batch payload to /bzz. ACT chains the data
        // to the current grantee list so only participants can decrypt.
        const { reference: actRef, historyAddress } = await this.client.uploadFile(JSON.stringify(batch), {
            act: true,
            actHistoryAddress: granteeHistRef,
            skipEncryption: true, // ACT handles it
        });
        const actHist = historyAddress ?? granteeHistRef;
        // Wrapper chunk: [actRef (32B) || actHist (32B)]. Uploaded plaintext so
        // the feed reader can read {actRef, actHist} pair without pre-shared state.
        const wrapper = new Uint8Array(WRAPPER_BYTES);
        wrapper.set(hexToBytes32(actRef), 0);
        wrapper.set(hexToBytes32(actHist), 32);
        const { reference: wrapperRef } = await this.client.uploadData(wrapper, {
            skipEncryption: true,
        });
        // Feed write at an explicit index (bee-js auto-pick can be stale
        // on public nodes, producing two writes at the same SOC slot).
        let nextIndex = this.lastWrittenIndex.get(topicHex);
        if (nextIndex === undefined) {
            const reader = this.client.bee.makeFeedReader(topic, this.client.getOwnerAddress());
            try {
                const head = await reader.downloadReference();
                nextIndex =
                    head?.feedIndexNext !== undefined
                        ? parseFeedIndex(head.feedIndexNext)
                        : parseFeedIndex(head.feedIndex) + 1;
            }
            catch {
                nextIndex = 0;
            }
        }
        else {
            nextIndex = nextIndex + 1;
        }
        await this.client.writeFeedPayloadAtIndex(topic, wrapperRef, nextIndex);
        this.lastWrittenIndex.set(topicHex, nextIndex);
        return { actRef, actHistoryAddress: actHist, feedIndex: nextIndex };
    }
    /**
     * Fast-path download: given the actRef + actHistoryAddress carried
     * in a GSOC `op-committed` ping, fetch the batch payload directly
     * from /bzz — bypassing the feed read entirely. This is the main
     * latency win, because cross-node feed propagation is slower than
     * cross-node /bzz content-addressed retrieval.
     *
     * Returns null on any download/decrypt failure (chunks not yet
     * propagated to the reader's neighborhood); caller should fall back
     * to the feed path.
     */
    async fetchByRefs(actRef, actHistoryAddress, publisherBeeNodePubKey) {
        try {
            const data = await this.client.downloadFile(actRef, {
                actPublisher: publisherBeeNodePubKey,
                actHistoryAddress,
                skipDecryption: true,
            });
            return JSON.parse(new TextDecoder().decode(data));
        }
        catch {
            return null;
        }
    }
    // ─── Read side ─────────────────────────────────────────────────
    /**
     * Latest feed index for a peer's feed, or null if the feed doesn't exist yet.
     */
    async getLatestIndex(collabId, driveId, documentId, peerAddress) {
        const topic = CollabOpsFeed.topicFor(collabId, driveId, documentId);
        try {
            const reader = this.client.bee.makeFeedReader(topic, peerAddress);
            const result = await reader.downloadReference();
            const base = parseFeedIndex(result.feedIndex);
            // Same stale-latest correction as CollabManifestFeed.readLatest.
            if (result.feedIndexNext !== undefined) {
                const nextIdx = parseFeedIndex(result.feedIndexNext);
                if (nextIdx > base + 1)
                    return nextIdx - 1;
            }
            return base;
        }
        catch {
            return null;
        }
    }
    /**
     * Read batches from index `fromIndex` (inclusive) up to and including
     * `toIndex`. Stops early at the first unreadable index (feed boundary or
     * chunk not yet propagated). Skips entries that don't decode to our
     * wrapper format.
     *
     * @param publisherBeeNodePubKey Peer's Bee node pubkey, needed for ACT decrypt.
     */
    async readRange(collabId, driveId, documentId, peerAddress, fromIndex, toIndex, publisherBeeNodePubKey) {
        if (fromIndex > toIndex)
            return [];
        const topic = CollabOpsFeed.topicFor(collabId, driveId, documentId);
        const reader = this.client.bee.makeFeedReader(topic, peerAddress);
        const out = [];
        for (let i = fromIndex; i <= toIndex; i++) {
            let wrapperRef;
            try {
                const result = await reader.downloadReference({
                    index: FeedIndex.fromBigInt(BigInt(i)),
                });
                wrapperRef = result.reference.toHex();
            }
            catch {
                // Index unavailable — treat as end of readable range and stop walking.
                break;
            }
            try {
                const wrapperBytes = await this.client.downloadData(wrapperRef, {
                    skipDecryption: true,
                });
                if (wrapperBytes.length !== WRAPPER_BYTES) {
                    continue; // not our wrapper format
                }
                const actRef = bytes32ToHex(wrapperBytes, 0);
                const actHist = bytes32ToHex(wrapperBytes, 32);
                const data = await this.client.downloadFile(actRef, {
                    actPublisher: publisherBeeNodePubKey,
                    actHistoryAddress: actHist,
                    skipDecryption: true,
                });
                const batch = JSON.parse(new TextDecoder().decode(data));
                out.push({ feedIndex: i, batch });
            }
            catch {
                // ACT decrypt failed (chunks not propagated yet, grantee not yet
                // visible to this node, etc). Skip this entry; a future poll can
                // pick it up once chunks propagate.
                continue;
            }
        }
        return out;
    }
}
//# sourceMappingURL=collab-ops-feed.js.map