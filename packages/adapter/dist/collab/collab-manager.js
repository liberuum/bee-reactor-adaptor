/**
 * CollabManager — orchestrates live collaboration setup on top of Swarm.
 *
 * MVP scope (Milestone 1 in live-collaboration-design.md):
 *   - `create()` builds the initial drive bundle, uploads it ACT-protected
 *     with every participant's Bee node pubkey as a grantee, and sends a
 *     chat-message invitation to each participant.
 *   - `accept()` imports the bundle via the existing share-import pipeline
 *     and records a local summary in localStorage so the user sees the
 *     collab in the Collaborate tab across reloads.
 *   - `list()` returns the active summaries; `leave()` removes one locally.
 *
 * Out of scope for M1 (Milestone 2+):
 *   - SwarmChannel peer-feed registration & dual push path to collab-scoped
 *     ACT feeds (handled separately — this manager just persists "who's
 *     participating" and emits events so the rest of the stack can wire up).
 *   - Collab-manifest feed with participant add/remove after invite time.
 *   - GSOC `op-committed` pings for real-time pulls.
 */
import { buildCollabId } from "./types.js";
const LS_SUMMARIES_KEY = "swarm:collabs";
export class CollabManager {
    client;
    chat;
    myAddress;
    summaries = new Map();
    handlers = new Set();
    constructor(client, chat, myAddress) {
        this.client = client;
        this.chat = chat;
        this.myAddress = myAddress;
        this.loadFromStorage();
    }
    // ─── Public API ────────────────────────────────────────────────
    /**
     * Create a new collaboration, invite each participant via chat, and
     * return the local summary.
     */
    async create(input) {
        const { target, participants, caption } = input;
        if (!target.driveId)
            throw new Error("driveId is required");
        if (!participants.length)
            throw new Error("at least one participant required");
        const kind = target.documentId ? "document" : "drive";
        const collabId = buildCollabId(kind, target.driveId, target.documentId);
        // Deduplicate participants + exclude self.
        const normalizedAddrs = Array.from(new Set(participants
            .map((a) => a.toLowerCase())
            .filter((a) => a && a !== this.myAddress.toLowerCase())));
        if (!normalizedAddrs.length) {
            throw new Error("no valid participants (excluding yourself)");
        }
        // 1. Resolve each participant's profile to get their Bee node pubkey.
        //    All grantees go on ONE ACT chain so a single upload serves everyone.
        const participantProfiles = [];
        for (const addr of normalizedAddrs) {
            const profile = await this.client.readPublicProfile(addr);
            if (!profile?.beeNodePublicKey) {
                throw new Error(`Participant ${addr} has no public profile or Bee node pubkey — they need to connect to Swarm first.`);
            }
            participantProfiles.push({
                address: addr,
                beeNodePublicKey: profile.beeNodePublicKey,
                displayName: profile.ensName ?? undefined,
            });
        }
        // 2. Build the drive bundle (same helper settings-share + chat-share use).
        const { buildDriveShareBundle } = await import("../plugin/sharing.js");
        const driveDocIds = target.documentId
            ? [target.documentId]
            : await this.listDocIdsInDrive(target.driveId);
        if (!driveDocIds.length) {
            throw new Error(`Drive ${target.driveId} has no documents to collaborate on.`);
        }
        const built = await buildDriveShareBundle(this.client, target.driveId, driveDocIds);
        if (!built) {
            throw new Error("Could not build drive bundle (no operations).");
        }
        // 3. Upload the bundle under ONE ACT chain with ALL participants as
        //    grantees. Every participant's Bee node can decrypt the same ref.
        const myBeeNodePubKey = await this.client.getBeeNodePublicKey();
        const granteeKeys = [
            myBeeNodePubKey,
            ...participantProfiles.map((p) => p.beeNodePublicKey),
        ];
        const { ref: granteeRef, historyRef } = await this.client.createGrantees(granteeKeys);
        const { reference: bundleRef, historyAddress } = await this.client.uploadFile(JSON.stringify(built.bundle), {
            act: true,
            actHistoryAddress: historyRef,
            skipEncryption: true, // ACT handles it
        });
        const bundleActHistoryAddress = historyAddress ?? historyRef;
        void granteeRef; // kept locally; future revocation work uses this ref
        // 4. Build the local summary.
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
        const summary = {
            collabId,
            kind,
            driveId: target.driveId,
            documentId: target.documentId,
            title: target.documentId
                ? (built.docs.find((d) => d.documentId === target.documentId)?.name ?? target.documentId)
                : built.driveName || target.driveId,
            initiator: this.myAddress.toLowerCase(),
            participants: participantsFull,
            manifestRef: bundleRef, // M1: the bundle IS the manifest
            manifestActHistoryAddress: bundleActHistoryAddress,
            manifestPublisherBeeNodePubKey: myBeeNodePubKey,
            lastActivityAt: now,
            status: "active",
        };
        // 5. Send an invitation chat message to each participant.
        const docInfo = target.documentId
            ? built.docs.find((d) => d.documentId === target.documentId)
            : undefined;
        for (const p of participantProfiles) {
            const session = await this.chat.startSession(p.address);
            const attachment = {
                kind: "collab-invite",
                collabId,
                collabKind: kind,
                title: summary.title,
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
            const text = caption
                ? caption
                : `You are invited to collaborate on "${summary.title}".`;
            await this.chat.sendMessage(session, text, attachment);
        }
        // 6. Persist + announce.
        this.summaries.set(collabId, summary);
        this.persist();
        this.emit({ type: "collab-created", collabId, data: summary });
        return summary;
    }
    /**
     * Accept a collab invitation received in chat. Downloads the initial
     * drive bundle via ACT, applies it to the local reactor, and records
     * the summary locally so the collab shows up in the Collaborate tab.
     */
    async accept(invite) {
        const { applyDocumentBundle } = await import("../plugin/sharing.js");
        // Download bundle with retry — Swarm chunks take a few seconds to
        // propagate after upload, matching the chat-share import behavior.
        const retryDelays = [0, 2000, 5000];
        let bundleData = null;
        let lastErr;
        for (const delay of retryDelays) {
            if (delay)
                await new Promise((r) => setTimeout(r, delay));
            try {
                bundleData = await this.client.downloadFile(invite.initialBundleRef, {
                    actPublisher: invite.initialBundlePublisherBeeNodePubKey,
                    actHistoryAddress: invite.initialBundleActHistoryAddress,
                    skipDecryption: true, // ACT already decrypted at the node
                });
                break;
            }
            catch (err) {
                lastErr = err;
            }
        }
        if (!bundleData) {
            throw new Error(`Could not download collab bundle: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
        }
        const result = await applyDocumentBundle(bundleData, {
            cacheKey: `swarm:collabAccept:${invite.collabId}`,
            displayName: invite.title,
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
        // Reconstruct participants from the invite + ensure self is present.
        const inviteParticipants = invite.participants.map((p) => ({
            address: p.address.toLowerCase(),
            // Bee node pubkeys aren't in the invite's participant list — they
            // live in the invite fields for the initiator's identity only. We
            // backfill lazily as needed when we start pulling their feeds.
            beeNodePublicKey: p.address.toLowerCase() === invite.invitedBy.toLowerCase()
                ? invite.manifestPublisherBeeNodePubKey
                : "",
            joinedAt: now,
            displayName: p.displayName,
        }));
        const participants = [
            mySelf,
            ...inviteParticipants.filter((p) => p.address !== mySelf.address),
        ];
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
            lastActivityAt: now,
            status: "active",
        };
        this.summaries.set(summary.collabId, summary);
        this.persist();
        this.emit({ type: "collab-accepted", collabId: summary.collabId, data: summary });
        return summary;
    }
    /**
     * Locally stop participating in a collab. M1 is local-only: we clear
     * the summary so pulls + UI stop. The initiator still lists this user
     * in their manifest until they rewrite it.
     */
    leave(collabId) {
        const existing = this.summaries.get(collabId);
        if (!existing)
            return;
        this.summaries.delete(collabId);
        this.persist();
        this.emit({ type: "collab-removed", collabId });
    }
    list() {
        return Array.from(this.summaries.values()).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    }
    get(collabId) {
        return this.summaries.get(collabId);
    }
    on(type, handler) {
        const wrapped = (evt) => {
            if (type === "*" || evt.type === type)
                handler(evt);
        };
        this.handlers.add(wrapped);
        return () => this.handlers.delete(wrapped);
    }
    // ─── Internal helpers ──────────────────────────────────────────
    emit(event) {
        for (const h of this.handlers) {
            try {
                h(event);
            }
            catch (err) {
                console.warn("[CollabManager] event handler threw:", err);
            }
        }
    }
    persist() {
        try {
            const raw = JSON.stringify(Array.from(this.summaries.values()));
            globalThis.window?.localStorage?.setItem?.(LS_SUMMARIES_KEY, raw);
        }
        catch {
            /* localStorage unavailable */
        }
    }
    loadFromStorage() {
        try {
            const raw = globalThis.window?.localStorage?.getItem?.(LS_SUMMARIES_KEY);
            if (!raw)
                return;
            const list = JSON.parse(raw);
            for (const s of list)
                this.summaries.set(s.collabId, s);
        }
        catch {
            /* ignore — corrupt or unavailable */
        }
    }
    /**
     * List doc IDs in a drive by reading the reactor's local state. Falls
     * back to an empty list if the reactor client isn't wired up.
     */
    async listDocIdsInDrive(driveId) {
        const ph = globalThis.window?.ph;
        const reactorClient = ph?.reactorClient;
        if (!reactorClient)
            return [];
        try {
            const drive = await reactorClient.get(driveId);
            const nodes = drive?.state?.global?.nodes ?? [];
            // Nodes are { id, kind: "file" | "folder", ... }; docs are "file" nodes.
            return nodes
                .filter((n) => n?.kind === "file" && typeof n?.id === "string")
                .map((n) => n.id);
        }
        catch {
            return [];
        }
    }
}
//# sourceMappingURL=collab-manager.js.map