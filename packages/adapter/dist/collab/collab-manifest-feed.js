/**
 * CollabManifestFeed — mutable source of truth for who's in a collab.
 *
 * Owned by the collab initiator. Each feed update points to an
 * ACT-protected JSON describing the current participant list. The feed
 * keeps its history so a participant who comes online after a revocation
 * can tell whether they were ever a member (some old index they could
 * read) vs whether they're still a member (the current index they can or
 * cannot read).
 *
 * Revocation strategy
 * -------------------
 *   - Initiator calls createGrantees with the SHORTER list, producing a new
 *     (granteeRef, granteeHistRef) pair. The removed peer's Bee pubkey is
 *     absent from the new chain.
 *   - Initiator writes a fresh manifest entry under the new chain. Future
 *     op-feed writes from any participant also use this chain (the manager
 *     pulls latest grantees on every appendBatch).
 *   - Content previously visible to the removed peer stays visible to them
 *     — ACT has no unbaking. The removal only blocks future decryption.
 */
import { Topic, FeedIndex } from "@ethersphere/bee-js";
import { collabManifestTopic } from "./types.js";
import { WRAPPER_BYTES, parseFeedIndex, hexToBytes32, bytes32ToHex } from "./feed-bytes.js";
export class CollabManifestFeed {
    client;
    /** Last index we wrote per topic. Lets publish() return a correct
     *  feedIndex even when Bee's post-write feed reads are still showing
     *  stale state (which we hit against public nodes). */
    lastWrittenIndex = new Map();
    /** Per-topic in-flight publish — same rationale as CollabOpsFeed's
     *  appendInFlight lock. Prevents two concurrent publish() calls from
     *  both deriving the same nextIndex and colliding on the same SOC. */
    publishInFlight = new Map();
    constructor(client) {
        this.client = client;
    }
    static topicFor(collabId) {
        return Topic.fromString(collabManifestTopic(collabId));
    }
    /**
     * Publish a manifest revision. Caller supplies the grantee set; this
     * class just writes. Rotation (shrinking the grantee list for
     * revocation) is the caller's responsibility: pass a fresh
     * granteeHistRef when the participants change.
     */
    async publish(manifest, granteeHistRef) {
        const topic = CollabManifestFeed.topicFor(manifest.collabId);
        const topicHex = topic.toHex();
        const prev = this.publishInFlight.get(topicHex) ?? Promise.resolve();
        const next = prev.then(() => this.publishLocked(topic, topicHex, manifest, granteeHistRef), () => this.publishLocked(topic, topicHex, manifest, granteeHistRef));
        this.publishInFlight.set(topicHex, next);
        try {
            return await next;
        }
        finally {
            if (this.publishInFlight.get(topicHex) === next) {
                this.publishInFlight.delete(topicHex);
            }
        }
    }
    async publishLocked(topic, topicHex, manifest, granteeHistRef) {
        const ownerAddress = this.client.getOwnerAddress();
        // Work out which index this write lands at. Prefer a local counter
        // (per-topic, seeded from Swarm on first access) because Bee's
        // immediate post-write reads are eventually-consistent on public
        // networks — we hit repeated feedIndex: 0 readbacks in integration.
        let nextIndex = this.lastWrittenIndex.get(topicHex);
        if (nextIndex === undefined) {
            const readerPre = this.client.bee.makeFeedReader(topic, ownerAddress);
            try {
                const head = await readerPre.downloadReference();
                // head.feedIndex = current latest. Next write lands at +1.
                // Some bee-js builds also expose feedIndexNext which is the same
                // thing precomputed — prefer it when present.
                nextIndex =
                    head?.feedIndexNext !== undefined
                        ? parseFeedIndex(head.feedIndexNext)
                        : parseFeedIndex(head.feedIndex) + 1;
            }
            catch {
                // Brand-new feed — our write lands at index 0.
                nextIndex = 0;
            }
        }
        else {
            nextIndex = nextIndex + 1;
        }
        const { reference: actRef, historyAddress } = await this.client.uploadFile(JSON.stringify(manifest), {
            act: true,
            actHistoryAddress: granteeHistRef,
            skipEncryption: true,
        });
        const actHist = historyAddress ?? granteeHistRef;
        // Wrap (actRef || actHist) into a 64-byte chunk so readers can
        // reconstruct the full decryption context from the feed alone.
        const wrapper = new Uint8Array(WRAPPER_BYTES);
        wrapper.set(hexToBytes32(actRef), 0);
        wrapper.set(hexToBytes32(actHist), 32);
        const { reference: wrapperRef } = await this.client.uploadData(wrapper, {
            skipEncryption: true,
        });
        // Write at the explicit index we decided above. bee-js's auto-pick
        // uses its own pre-read which is stale on public nodes — passing the
        // index ourselves keeps the counter consistent.
        await this.client.writeFeedPayloadAtIndex(topic, wrapperRef, nextIndex);
        this.lastWrittenIndex.set(topicHex, nextIndex);
        return { feedIndex: nextIndex, actRef, actHistoryAddress: actHist };
    }
    /**
     * Read the latest manifest revision, or null if the feed doesn't exist
     * or the chunk hasn't propagated to this node yet.
     *
     * @param readerBeeNodePubKey — the initiator's Bee node pubkey. Needed
     *    as `actPublisher` for ACT decrypt.
     */
    async readLatest(collabId, ownerSignerAddress, readerBeeNodePubKey) {
        const topic = CollabManifestFeed.topicFor(collabId);
        const reader = this.client.bee.makeFeedReader(topic, ownerSignerAddress);
        let wrapperRef;
        let feedIndex = 0;
        try {
            const result = await reader.downloadReference();
            wrapperRef = result.reference.toHex();
            feedIndex = parseFeedIndex(result.feedIndex);
            // Bee's "latest" feed lookup (downloadReference with no args) can
            // return a stale entry when multiple updates land in quick
            // succession — the feedIndexNext header still correctly advances,
            // so if next > feedIndex+1 we know the real latest is elsewhere
            // and re-fetch by explicit index.
            if (result.feedIndexNext !== undefined) {
                const nextIdx = parseFeedIndex(result.feedIndexNext);
                if (nextIdx > feedIndex + 1) {
                    const realLatest = nextIdx - 1;
                    const m = await this.readAtIndex(collabId, ownerSignerAddress, readerBeeNodePubKey, realLatest);
                    if (m)
                        return { manifest: m, feedIndex: realLatest };
                    // Fall through to use the first-returned entry if the explicit
                    // lookup for the real latest fails (chunk not propagated).
                    feedIndex = realLatest;
                }
            }
        }
        catch {
            return null;
        }
        try {
            const wrapperBytes = await this.client.downloadData(wrapperRef, {
                skipDecryption: true,
            });
            if (wrapperBytes.length !== WRAPPER_BYTES)
                return null;
            const actRef = bytes32ToHex(wrapperBytes, 0);
            const actHist = bytes32ToHex(wrapperBytes, 32);
            const data = await this.client.downloadFile(actRef, {
                actPublisher: readerBeeNodePubKey,
                actHistoryAddress: actHist,
                skipDecryption: true,
            });
            const manifest = JSON.parse(new TextDecoder().decode(data));
            return { manifest, feedIndex };
        }
        catch {
            return null;
        }
    }
    /**
     * Read a specific feed index, if accessible. Used by participants who
     * were revoked after index N — they can still read up to N via
     * feedIndex lookups.
     */
    async readAtIndex(collabId, ownerSignerAddress, readerBeeNodePubKey, index) {
        const topic = CollabManifestFeed.topicFor(collabId);
        const reader = this.client.bee.makeFeedReader(topic, ownerSignerAddress);
        let wrapperRef;
        try {
            const result = await reader.downloadReference({
                index: FeedIndex.fromBigInt(BigInt(index)),
            });
            wrapperRef = result.reference.toHex();
        }
        catch {
            return null;
        }
        try {
            const wrapperBytes = await this.client.downloadData(wrapperRef, {
                skipDecryption: true,
            });
            if (wrapperBytes.length !== WRAPPER_BYTES)
                return null;
            const actRef = bytes32ToHex(wrapperBytes, 0);
            const actHist = bytes32ToHex(wrapperBytes, 32);
            const data = await this.client.downloadFile(actRef, {
                actPublisher: readerBeeNodePubKey,
                actHistoryAddress: actHist,
                skipDecryption: true,
            });
            return JSON.parse(new TextDecoder().decode(data));
        }
        catch {
            return null;
        }
    }
}
//# sourceMappingURL=collab-manifest-feed.js.map