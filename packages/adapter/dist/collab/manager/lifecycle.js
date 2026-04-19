/**
 * CollabLifecycle — the high-level collab-state transitions:
 *
 *   • `create`             — bundle + ACT-upload + manifest publish + invites
 *   • `accept`             — download bundle + apply locally + record summary
 *   • `revokeParticipant`  — rotate the ACT grantee chain + new manifest
 *   • `addParticipant`     — patchGrantees + new manifest + invite
 *   • `refreshManifest`    — re-read the manifest feed for participant updates
 *   • `leave`              — drop local + strip from user manifest
 *
 * All ACT uploads follow the "sleep 1.1s between mantaray touches"
 * rule so consecutive writes don't collide on the same timestamp.
 */
import { buildCollabId } from "../types.js";
import { CollabManifestFeed } from "../collab-manifest-feed.js";
import { removeCollabFromUserManifest } from "../../channel/manifest-manager.js";
import { listDocIdsInDrive } from "./reactor-bridge.js";
import { pushActivity } from "./store.js";
/**
 * Older profile writers embedded an `ensName` on the public profile for
 * display purposes. It's not part of the canonical SwarmPublicProfile
 * shape, so this helper narrows the lookup without a blanket `any`.
 */
function displayNameFromProfile(profile) {
    const candidate = profile.ensName;
    return typeof candidate === "string" ? candidate : undefined;
}
/** ACT mantaray timestamps must differ by >= 1s between writes on the
 *  same chain. We sleep 1.1s after every grantee-chain touch so the
 *  next write doesn't collide in the same bucket. */
const ACT_MANTARAY_COOLDOWN_MS = 1100;
export class CollabLifecycle {
    client;
    chat;
    myAddress;
    store;
    events;
    gsoc;
    userManifestSync;
    manifestFeed;
    constructor(client, chat, myAddress, store, events, gsoc, userManifestSync) {
        this.client = client;
        this.chat = chat;
        this.myAddress = myAddress;
        this.store = store;
        this.events = events;
        this.gsoc = gsoc;
        this.userManifestSync = userManifestSync;
        this.manifestFeed = new CollabManifestFeed(client);
    }
    /**
     * Exposed so push-hook can re-read the manifest when lazily building
     * a grantee chain for a joiner. Returning the feed from a sibling
     * module would leak internal state — route through here instead.
     */
    async refreshManifest(collabId) {
        const summary = this.store.get(collabId);
        if (!summary)
            return null;
        const latest = await this.manifestFeed.readLatest(collabId, summary.initiator, summary.manifestPublisherBeeNodePubKey);
        if (!latest)
            return summary;
        if (summary.manifestFeedIndex != null &&
            latest.feedIndex <= summary.manifestFeedIndex) {
            return summary; // nothing new
        }
        const updated = {
            ...summary,
            participants: latest.manifest.participants,
            manifestFeedIndex: latest.feedIndex,
            title: latest.manifest.title ?? summary.title,
            lastActivityAt: new Date().toISOString(),
        };
        this.store.set(collabId, updated);
        this.events.emit({ type: "collab-updated", collabId, data: updated });
        return updated;
    }
    /**
     * Reader used by the rehydrator. Kept here so the manifest feed
     * stays a single-owner resource scoped to this module.
     */
    getManifestFeed() {
        return this.manifestFeed;
    }
    // ─── create ─────────────────────────────────────────────────────
    async create(input) {
        const { target, participants, caption } = input;
        if (!target.driveId)
            throw new Error("driveId is required");
        if (!participants.length)
            throw new Error("at least one participant required");
        const kind = target.documentId ? "document" : "drive";
        const collabId = buildCollabId(kind, target.driveId, target.documentId);
        const normalizedAddrs = dedupeParticipants(participants, this.myAddress);
        if (!normalizedAddrs.length) {
            throw new Error("no valid participants (excluding yourself)");
        }
        // Resolve each participant's profile — we need their Bee node pubkey
        // for the ACT grantee chain.
        const participantProfiles = await this.resolveParticipantProfiles(normalizedAddrs);
        // Build the drive bundle (same helper settings-share + chat-share use).
        const { buildDriveShareBundle } = await import("../../plugin/sharing.js");
        const driveDocIds = target.documentId
            ? [target.documentId]
            : await listDocIdsInDrive(target.driveId);
        if (!driveDocIds.length) {
            throw new Error(`Drive ${target.driveId} has no documents to collaborate on.`);
        }
        const built = await buildDriveShareBundle(this.client, target.driveId, driveDocIds);
        if (!built) {
            throw new Error("Could not build drive bundle (no operations).");
        }
        // Build the participant list (self + invited peers) and create ONE
        // ACT grantee chain covering everyone — a single chain used for the
        // initial bundle, the manifest feed, AND all future op-batch writes.
        // Rotating it is what "revocation" means.
        const myBeeNodePubKey = await this.client.getBeeNodePublicKey();
        const now = new Date().toISOString();
        const selfParticipant = {
            address: this.myAddress.toLowerCase(),
            beeNodePublicKey: myBeeNodePubKey,
            joinedAt: now,
        };
        const participantsFull = [
            selfParticipant,
            ...participantProfiles.map((p) => ({
                address: p.address,
                beeNodePublicKey: p.beeNodePublicKey,
                joinedAt: now,
                displayName: p.displayName,
            })),
        ];
        const granteeKeys = participantsFull.map((p) => p.beeNodePublicKey);
        const { ref: granteeRef, historyRef } = await this.client.createGrantees(granteeKeys);
        await sleep(ACT_MANTARAY_COOLDOWN_MS);
        // Upload the initial drive bundle under that chain.
        const { reference: bundleRef, historyAddress } = await this.client.uploadFile(JSON.stringify(built.bundle), {
            act: true,
            actHistoryAddress: historyRef,
            skipEncryption: true,
        });
        const bundleActHistoryAddress = historyAddress ?? historyRef;
        await sleep(ACT_MANTARAY_COOLDOWN_MS);
        const title = target.documentId
            ? (built.docs.find((d) => d.documentId === target.documentId)?.name ?? target.documentId)
            : built.driveName || target.driveId;
        // Publish the CollabManifest to its own feed. This feed is the
        // *live* source of truth for membership — revocation and additions
        // write new feed entries; participants refresh from here.
        const manifest = {
            version: 1,
            collabId,
            kind,
            driveId: target.driveId,
            documentId: target.documentId,
            title,
            participants: participantsFull,
            initiator: this.myAddress.toLowerCase(),
            createdAt: now,
            updatedAt: now,
            caption,
        };
        const { feedIndex: manifestFeedIndex } = await this.manifestFeed.publish(manifest, historyRef);
        const summary = {
            collabId,
            kind,
            driveId: target.driveId,
            documentId: target.documentId,
            title,
            initiator: this.myAddress.toLowerCase(),
            participants: participantsFull,
            manifestRef: bundleRef,
            manifestActHistoryAddress: bundleActHistoryAddress,
            manifestPublisherBeeNodePubKey: myBeeNodePubKey,
            manifestFeedIndex,
            currentGranteeHistRef: historyRef,
            currentGranteeRef: granteeRef,
            lastActivityAt: now,
            status: "active",
            peerActivity: {},
            recentActivity: [
                { at: now, kind: "created", actor: this.myAddress.toLowerCase() },
                ...participantProfiles.map((p) => ({
                    at: now,
                    kind: "participant-added",
                    actor: p.address,
                })),
            ],
        };
        // Send an invitation chat message to each participant. Message
        // carries initial-bundle refs (one-shot snapshot) AND the manifest
        // feed coordinates (for the live participant list).
        const docInfo = target.documentId
            ? built.docs.find((d) => d.documentId === target.documentId)
            : undefined;
        for (const p of participantProfiles) {
            const session = await this.chat.startSession(p.address);
            const attachment = {
                kind: "collab-invite",
                collabId,
                collabKind: kind,
                title,
                driveId: target.driveId,
                driveName: built.driveName,
                documentId: target.documentId,
                documentName: docInfo?.name,
                manifestRef: bundleRef,
                manifestActHistoryAddress: bundleActHistoryAddress,
                manifestPublisherBeeNodePubKey: myBeeNodePubKey,
                initialBundleRef: bundleRef,
                initialBundleActHistoryAddress: bundleActHistoryAddress,
                initialBundlePublisherBeeNodePubKey: myBeeNodePubKey,
                participants: participantsFull.map((pp) => ({
                    address: pp.address,
                    displayName: pp.displayName,
                })),
                invitedBy: this.myAddress.toLowerCase(),
                invitedAt: now,
                caption,
            };
            const text = caption ?? `You are invited to collaborate on "${title}".`;
            await this.chat.sendMessage(session, text, attachment);
        }
        this.store.set(collabId, summary);
        // Authoritative record on Swarm — survives browser wipes. Written
        // AFTER the manifest feed is up so a peer rehydrating can find a
        // readable feed.
        void this.userManifestSync.upsert(summary).catch((err) => {
            console.warn("[CollabManager] create: user-manifest write failed (non-fatal):", err instanceof Error ? err.message : err);
        });
        // Background: mine GSOC signers per peer + publish our outbound
        // addresses to our profile. Non-blocking — first push might hit
        // before mining completes; poll-loop covers the gap.
        // Also subscribe to each peer's outbound-to-me channel; on create,
        // the peers haven't accepted yet so the first attempt returns no
        // listen address and drops them back into the dedup-reset state.
        // The poll-loop retries every tick until the peer publishes.
        void this.gsoc.provisionOutbound(collabId, participantsFull)
            .then(() => this.gsoc.subscribeToPeers(summary))
            .catch((err) => {
            console.warn("[CollabManager] GSOC provision (create) failed:", err instanceof Error ? err.message : err);
        });
        this.events.emit({ type: "collab-created", collabId, data: summary });
        return summary;
    }
    // ─── accept ─────────────────────────────────────────────────────
    async accept(invite) {
        const { applyDocumentBundle } = await import("../../plugin/sharing.js");
        const bundleData = await this.downloadInitialBundle(invite);
        const result = await applyDocumentBundle(bundleData, {
            cacheKey: `swarm:collabAccept:${invite.collabId}`,
            displayName: invite.title,
            // Live collab requires both sides to share the same drive + doc
            // IDs so the per-(collab, drive, doc, writer) feed topics align
            // and reactor.load on incoming ops targets the correct local doc.
            preserveIds: { driveId: invite.driveId },
        });
        if (!result.success) {
            throw new Error(result.error ?? "Failed to apply collab bundle");
        }
        const now = new Date().toISOString();
        const myBeeNodePubKey = await this.client.getBeeNodePublicKey();
        const mySelf = {
            address: this.myAddress.toLowerCase(),
            beeNodePublicKey: myBeeNodePubKey,
            joinedAt: now,
        };
        const { participants, manifestFeedIndex } = await this.resolveAcceptParticipants(invite, mySelf, now);
        const summary = {
            collabId: invite.collabId,
            kind: invite.collabKind,
            driveId: result.driveId ?? invite.driveId,
            documentId: invite.documentId,
            title: invite.title,
            initiator: invite.invitedBy.toLowerCase(),
            participants,
            manifestRef: invite.manifestRef,
            manifestActHistoryAddress: invite.manifestActHistoryAddress,
            manifestPublisherBeeNodePubKey: invite.manifestPublisherBeeNodePubKey,
            manifestFeedIndex,
            // Non-initiators don't own the grantee chain; they ingest ops but
            // don't write collab feed entries until they make local edits.
            // Their ACT chain for writes gets lazily created from the current
            // participant set the first time handleLocalPush fires.
            lastActivityAt: now,
            status: "active",
            peerActivity: {},
            recentActivity: [
                { at: now, kind: "accepted", actor: this.myAddress.toLowerCase() },
            ],
        };
        this.store.set(summary.collabId, summary);
        void this.userManifestSync.upsert(summary).catch((err) => {
            console.warn("[CollabManager] accept: user-manifest write failed (non-fatal):", err instanceof Error ? err.message : err);
        });
        // Provision our outbound GSOC to each peer (so they can subscribe
        // and learn when we push) and subscribe to theirs (so we pull on
        // their pushes). Both run in the background, best-effort. After
        // provisioning resolves, broadcast a "collab-join" ping so the
        // initiator's UI can flip from "Awaiting" to joined without
        // waiting for our first edit to land.
        void this.gsoc.provisionOutbound(summary.collabId, participants)
            .then(() => this.gsoc.broadcastJoined(summary))
            .catch((err) => {
            console.warn("[CollabManager] GSOC provision (accept) failed:", err instanceof Error ? err.message : err);
        });
        void this.gsoc.subscribeToPeers(summary).catch((err) => {
            console.warn("[CollabManager] GSOC subscribe (accept) failed:", err instanceof Error ? err.message : err);
        });
        this.events.emit({ type: "collab-accepted", collabId: summary.collabId, data: summary });
        return summary;
    }
    /**
     * Download the initial bundle with retry — Swarm chunks take a few
     * seconds to propagate after upload, matching the chat-share import
     * behavior.
     */
    async downloadInitialBundle(invite) {
        const retryDelays = [0, 2000, 5000];
        let lastErr;
        for (const delay of retryDelays) {
            if (delay)
                await sleep(delay);
            try {
                return await this.client.downloadFile(invite.initialBundleRef, {
                    actPublisher: invite.initialBundlePublisherBeeNodePubKey,
                    actHistoryAddress: invite.initialBundleActHistoryAddress,
                    skipDecryption: true, // ACT already decrypted at the node
                });
            }
            catch (err) {
                lastErr = err;
            }
        }
        throw new Error(`Could not download collab bundle: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    }
    /**
     * Try the authoritative manifest feed first; fall back to the
     * invite's slim participant list if the feed isn't reachable yet
     * (chunk not propagated).
     */
    async resolveAcceptParticipants(invite, mySelf, now) {
        try {
            const latest = await this.manifestFeed.readLatest(invite.collabId, invite.invitedBy, invite.manifestPublisherBeeNodePubKey);
            if (latest) {
                const listed = latest.manifest.participants.map((p) => ({
                    ...p,
                    address: p.address.toLowerCase(),
                }));
                const hasSelf = listed.some((p) => p.address === mySelf.address);
                return {
                    participants: hasSelf ? listed : [...listed, mySelf],
                    manifestFeedIndex: latest.feedIndex,
                };
            }
        }
        catch (err) {
            console.warn("[CollabManager] accept: manifest feed read failed, falling back to invite participants:", err instanceof Error ? err.message : err);
        }
        // Fallback — invite's slim list (only the initiator has a known
        // pubkey, others will have empty pubkeys until refreshManifest).
        const inviteParticipants = invite.participants.map((p) => ({
            address: p.address.toLowerCase(),
            beeNodePublicKey: p.address.toLowerCase() === invite.invitedBy.toLowerCase()
                ? invite.manifestPublisherBeeNodePubKey
                : "",
            joinedAt: now,
            displayName: p.displayName,
        }));
        return {
            participants: [
                mySelf,
                ...inviteParticipants.filter((p) => p.address !== mySelf.address),
            ],
        };
    }
    // ─── revoke / add ───────────────────────────────────────────────
    /**
     * Initiator-only: revoke a participant.
     *
     * Rebuilds the ACT grantee chain without that participant's Bee pubkey
     * and publishes a new manifest revision. Future op-batch writes use
     * the new chain, so the revoked peer's Bee node can no longer decrypt
     * them. Content previously accessible to them stays accessible — ACT
     * has no rewind. Revoke is about the *future*.
     */
    async revokeParticipant(collabId, peerAddress) {
        const summary = this.requireInitiatorOnly(collabId, "revoke participants");
        const addr = peerAddress.toLowerCase();
        if (addr === summary.initiator) {
            throw new Error("The initiator cannot revoke themselves (leave instead).");
        }
        if (!summary.participants.some((p) => p.address === addr)) {
            throw new Error(`Participant not found: ${peerAddress}`);
        }
        const nextParticipants = summary.participants.filter((p) => p.address !== addr);
        const granteeKeys = nextParticipants.map((p) => p.beeNodePublicKey);
        const { ref: granteeRef, historyRef } = await this.client.createGrantees(granteeKeys);
        await sleep(ACT_MANTARAY_COOLDOWN_MS);
        const now = new Date().toISOString();
        const manifest = this.buildManifestRevision(summary, {
            participants: nextParticipants,
            now,
        });
        const { feedIndex } = await this.manifestFeed.publish(manifest, historyRef);
        const updated = {
            ...summary,
            participants: nextParticipants,
            currentGranteeRef: granteeRef,
            currentGranteeHistRef: historyRef,
            manifestFeedIndex: feedIndex,
            lastActivityAt: now,
            recentActivity: pushActivity(summary.recentActivity, {
                at: now,
                kind: "participant-revoked",
                actor: addr,
            }),
        };
        this.store.set(collabId, updated);
        this.events.emit({ type: "collab-updated", collabId, data: updated });
        return updated;
    }
    /**
     * Initiator-only: add a participant.
     *
     * Resolves the new peer's profile, extends the ACT grantee chain via
     * `patchGrantees` (incremental — no rewrite), and publishes a new
     * manifest revision. The new participant receives a standard
     * invitation chat message pointing at the current bundle + manifest.
     */
    async addParticipant(collabId, peerAddress) {
        const summary = this.requireInitiatorOnly(collabId, "add participants");
        const addr = peerAddress.toLowerCase();
        if (summary.participants.some((p) => p.address === addr)) {
            throw new Error(`Participant already in the collab: ${peerAddress}`);
        }
        const profile = await this.client.readPublicProfile(addr);
        if (!profile?.beeNodePublicKey) {
            throw new Error(`Participant ${peerAddress} has no public profile or Bee node pubkey — they need to connect to Swarm first.`);
        }
        if (!summary.currentGranteeHistRef || !summary.currentGranteeRef) {
            throw new Error("Collab is missing its current grantee chain — refreshManifest() first.");
        }
        const patched = await this.client.grantAccess(summary.currentGranteeRef, summary.currentGranteeHistRef, [profile.beeNodePublicKey]);
        await sleep(ACT_MANTARAY_COOLDOWN_MS);
        const now = new Date().toISOString();
        const newParticipant = {
            address: addr,
            beeNodePublicKey: profile.beeNodePublicKey,
            joinedAt: now,
            displayName: displayNameFromProfile(profile),
        };
        const nextParticipants = [...summary.participants, newParticipant];
        const manifest = this.buildManifestRevision(summary, {
            participants: nextParticipants,
            now,
        });
        const { feedIndex } = await this.manifestFeed.publish(manifest, patched.historyRef);
        const updated = {
            ...summary,
            participants: nextParticipants,
            currentGranteeRef: patched.ref,
            currentGranteeHistRef: patched.historyRef,
            manifestFeedIndex: feedIndex,
            lastActivityAt: now,
            recentActivity: pushActivity(summary.recentActivity, {
                at: now,
                kind: "participant-added",
                actor: addr,
            }),
        };
        this.store.set(collabId, updated);
        // Best-effort invite — don't fail the whole add on chat hiccups.
        try {
            const session = await this.chat.startSession(addr);
            const attachment = {
                kind: "collab-invite",
                collabId,
                collabKind: summary.kind,
                title: summary.title,
                driveId: summary.driveId,
                driveName: summary.title,
                documentId: summary.documentId,
                manifestRef: summary.manifestRef,
                manifestActHistoryAddress: summary.manifestActHistoryAddress,
                manifestPublisherBeeNodePubKey: summary.manifestPublisherBeeNodePubKey,
                initialBundleRef: summary.manifestRef,
                initialBundleActHistoryAddress: summary.manifestActHistoryAddress,
                initialBundlePublisherBeeNodePubKey: summary.manifestPublisherBeeNodePubKey,
                participants: nextParticipants.map((pp) => ({
                    address: pp.address,
                    displayName: pp.displayName,
                })),
                invitedBy: this.myAddress.toLowerCase(),
                invitedAt: now,
            };
            await this.chat.sendMessage(session, `You were added to "${summary.title}".`, attachment);
        }
        catch (err) {
            console.warn(`[CollabManager] addParticipant: chat invite send failed (continuing):`, err instanceof Error ? err.message : err);
        }
        this.events.emit({ type: "collab-updated", collabId, data: updated });
        return updated;
    }
    // ─── leave ──────────────────────────────────────────────────────
    /**
     * Stop participating in a collab on this device + strip the entry
     * from the user manifest so a fresh browser doesn't re-hydrate it.
     * The initiator's collab manifest feed is untouched — they still
     * list this user as a participant until they explicitly revoke.
     */
    async leave(collabId) {
        if (!this.store.has(collabId))
            return;
        this.store.delete(collabId);
        try {
            await removeCollabFromUserManifest(this.client, this.myAddress, collabId);
        }
        catch (err) {
            console.warn("[CollabManager] leave: user-manifest remove failed (local state already cleared):", err instanceof Error ? err.message : err);
        }
        this.events.emit({ type: "collab-removed", collabId });
    }
    // ─── Internal helpers ──────────────────────────────────────────
    requireInitiatorOnly(collabId, action) {
        const summary = this.store.get(collabId);
        if (!summary)
            throw new Error(`Unknown collab: ${collabId}`);
        if (summary.initiator !== this.myAddress.toLowerCase()) {
            throw new Error(`Only the collab initiator can ${action}.`);
        }
        return summary;
    }
    buildManifestRevision(base, overrides) {
        return {
            version: 1,
            collabId: base.collabId,
            kind: base.kind,
            driveId: base.driveId,
            documentId: base.documentId,
            title: base.title,
            participants: overrides.participants,
            initiator: base.initiator,
            createdAt: base.participants.find((p) => p.address === base.initiator)?.joinedAt
                ?? overrides.now,
            updatedAt: overrides.now,
        };
    }
    async resolveParticipantProfiles(addresses) {
        const out = [];
        for (const addr of addresses) {
            const profile = await this.client.readPublicProfile(addr);
            if (!profile?.beeNodePublicKey) {
                throw new Error(`Participant ${addr} has no public profile or Bee node pubkey — they need to connect to Swarm first.`);
            }
            out.push({
                address: addr,
                beeNodePublicKey: profile.beeNodePublicKey,
                displayName: displayNameFromProfile(profile),
            });
        }
        return out;
    }
}
function dedupeParticipants(participants, myAddress) {
    const me = myAddress.toLowerCase();
    return Array.from(new Set(participants
        .map((a) => a.toLowerCase())
        .filter((a) => a && a !== me)));
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=lifecycle.js.map