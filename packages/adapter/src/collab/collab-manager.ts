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

import type { SwarmClient } from "../swarm-client.js";
import type { ChatManager } from "../chat/chat-manager.js";
import type {
  CollabEvent,
  CollabEventHandler,
  CollabEventType,
  CollabId,
  CollabKind,
  CollabParticipant,
  CollabSummary,
  CollabInviteAttachment,
} from "./types.js";
import { buildCollabId } from "./types.js";
import { CollabOpsFeed } from "./collab-ops-feed.js";
import type { CollabOpsBatch } from "./collab-ops-feed.js";
import { CollabManifestFeed } from "./collab-manifest-feed.js";
import type { CollabManifest } from "./types.js";
import {
  ensureCollabInUserManifest,
  listCollabsFromUserManifest,
  removeCollabFromUserManifest,
} from "../channel/manifest-manager.js";
import type { UserCollabEntry } from "../types.js";

const LS_SUMMARIES_KEY = "swarm:collabs";
const LS_PEER_CURSOR_PREFIX = "swarm:collabPeerCursor:";
const POLL_INTERVAL_MS = 5000;

export interface CreateCollabInput {
  target: { driveId: string; documentId?: string };
  participants: string[]; // Swarm signer addresses (lowercase hex)
  caption?: string;
}

export class CollabManager {
  private readonly summaries = new Map<CollabId, CollabSummary>();
  private readonly handlers = new Set<CollabEventHandler>();
  private readonly opsFeed: CollabOpsFeed;
  private readonly manifestFeed: CollabManifestFeed;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private shuttingDown = false;

  constructor(
    private readonly client: SwarmClient,
    private readonly chat: ChatManager,
    private readonly myAddress: string,
  ) {
    this.opsFeed = new CollabOpsFeed(client);
    this.manifestFeed = new CollabManifestFeed(client);
    this.loadFromStorage();
    this.startPolling();
    // Install the push hook so SwarmChannel can notify us on every local
    // op flush. Stable global so channels created before this manager
    // (cold start, HMR) can still find it lazily.
    (globalThis as any).__swarmCollabManager__ = this;
    // Rehydrate from the user manifest on Swarm — authoritative source
    // of "which collabs am I in". Local summaries (localStorage) are a
    // startup cache; on a fresh browser they start empty and this
    // backfills from Swarm. Runs in background, not awaited.
    void this.rehydrateFromUserManifest();
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if ((globalThis as any).__swarmCollabManager__ === this) {
      (globalThis as any).__swarmCollabManager__ = null;
    }
  }

  // ─── Public API ────────────────────────────────────────────────

  /**
   * Create a new collaboration, invite each participant via chat, and
   * return the local summary.
   */
  async create(input: CreateCollabInput): Promise<CollabSummary> {
    const { target, participants, caption } = input;
    if (!target.driveId) throw new Error("driveId is required");
    if (!participants.length) throw new Error("at least one participant required");

    const kind: CollabKind = target.documentId ? "document" : "drive";
    const collabId = buildCollabId(kind, target.driveId, target.documentId);

    // Deduplicate participants + exclude self.
    const normalizedAddrs = Array.from(
      new Set(
        participants
          .map((a) => a.toLowerCase())
          .filter((a) => a && a !== this.myAddress.toLowerCase()),
      ),
    );
    if (!normalizedAddrs.length) {
      throw new Error("no valid participants (excluding yourself)");
    }

    // 1. Resolve each participant's profile to get their Bee node pubkey.
    //    All grantees go on ONE ACT chain so a single upload serves everyone.
    const participantProfiles: Array<{
      address: string;
      beeNodePublicKey: string;
      displayName?: string;
    }> = [];
    for (const addr of normalizedAddrs) {
      const profile = await this.client.readPublicProfile(addr);
      if (!profile?.beeNodePublicKey) {
        throw new Error(
          `Participant ${addr} has no public profile or Bee node pubkey — they need to connect to Swarm first.`,
        );
      }
      participantProfiles.push({
        address: addr,
        beeNodePublicKey: profile.beeNodePublicKey,
        displayName: (profile as any).ensName ?? undefined,
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

    // 3. Build the participant list (self + invited peers) and create
    //    ONE ACT grantee chain covering everyone. This single chain is
    //    used for the initial bundle, the manifest feed, AND all future
    //    op-batch writes — rotating it is what "revocation" means.
    const myBeeNodePubKey = await this.client.getBeeNodePublicKey();
    const now = new Date().toISOString();
    const selfParticipant: CollabParticipant = {
      address: this.myAddress.toLowerCase(),
      beeNodePublicKey: myBeeNodePubKey,
      joinedAt: now,
    };
    const participantsFull: CollabParticipant[] = [
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
    // ACT mantaray timestamps must differ by >= 1s between writes. Sleep
    // so the initial bundle, the manifest, and the first op batch don't
    // all collide.
    await new Promise((r) => setTimeout(r, 1100));

    // 4. Upload the initial drive bundle under that chain.
    const { reference: bundleRef, historyAddress } = await this.client.uploadFile(
      JSON.stringify(built.bundle),
      {
        act: true,
        actHistoryAddress: historyRef,
        skipEncryption: true,
      },
    );
    const bundleActHistoryAddress = historyAddress ?? historyRef;
    await new Promise((r) => setTimeout(r, 1100));

    const title = target.documentId
      ? (built.docs.find((d) => d.documentId === target.documentId)?.name ?? target.documentId!)
      : built.driveName || target.driveId;

    // 5. Publish the CollabManifest to its own feed. This feed is the
    //    *live* source of truth for membership — revocation and
    //    additions write new feed entries. Participants refresh from here.
    const manifest: CollabManifest = {
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

    // 6. Build the local summary. Track current grantee refs so
    //    subsequent writes (op batches, manifest rewrites) can reuse
    //    them and so revocation can rotate them atomically.
    const summary: CollabSummary = {
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
    };

    // 7. Send an invitation chat message to each participant. Message
    //    carries initial-bundle refs (one-shot snapshot) AND the
    //    manifest feed coordinates (for the live participant list).
    const docInfo = target.documentId
      ? built.docs.find((d) => d.documentId === target.documentId)
      : undefined;
    for (const p of participantProfiles) {
      const session = await this.chat.startSession(p.address);
      const attachment: CollabInviteAttachment = {
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
      const text = caption
        ? caption
        : `You are invited to collaborate on "${title}".`;
      await this.chat.sendMessage(session, text, attachment);
    }

    // 8. Persist + announce.
    this.summaries.set(collabId, summary);
    this.persist();
    // Authoritative record on Swarm — survives browser wipes. Written
    // AFTER the manifest feed is up so a peer rehydrating can find a
    // readable feed.
    void this.upsertUserManifestEntry(summary).catch((err) => {
      console.warn(
        "[CollabManager] create: user-manifest write failed (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    });
    this.emit({ type: "collab-created", collabId, data: summary });

    return summary;
  }

  /**
   * Initiator-only: revoke a participant.
   *
   * Rebuilds the ACT grantee chain without that participant's Bee pubkey
   * and publishes a new manifest revision. Future op-batch writes use the
   * new chain, so the revoked peer's Bee node can no longer decrypt them.
   * Content previously accessible to them stays accessible — ACT has no
   * rewind. The revoke is about the *future*.
   */
  async revokeParticipant(collabId: CollabId, peerAddress: string): Promise<CollabSummary> {
    const summary = this.summaries.get(collabId);
    if (!summary) throw new Error(`Unknown collab: ${collabId}`);
    if (summary.initiator !== this.myAddress.toLowerCase()) {
      throw new Error("Only the collab initiator can revoke participants.");
    }
    const addr = peerAddress.toLowerCase();
    if (addr === summary.initiator) {
      throw new Error("The initiator cannot revoke themselves (leave instead).");
    }
    const target = summary.participants.find((p) => p.address === addr);
    if (!target) throw new Error(`Participant not found: ${peerAddress}`);

    const nextParticipants = summary.participants.filter((p) => p.address !== addr);
    const granteeKeys = nextParticipants.map((p) => p.beeNodePublicKey);
    const { ref: granteeRef, historyRef } = await this.client.createGrantees(granteeKeys);
    await new Promise((r) => setTimeout(r, 1100));

    const now = new Date().toISOString();
    const manifest: CollabManifest = {
      version: 1,
      collabId,
      kind: summary.kind,
      driveId: summary.driveId,
      documentId: summary.documentId,
      title: summary.title,
      participants: nextParticipants,
      initiator: summary.initiator,
      createdAt: summary.participants.find((p) => p.address === summary.initiator)?.joinedAt ?? now,
      updatedAt: now,
    };
    const { feedIndex } = await this.manifestFeed.publish(manifest, historyRef);

    const updated: CollabSummary = {
      ...summary,
      participants: nextParticipants,
      currentGranteeRef: granteeRef,
      currentGranteeHistRef: historyRef,
      manifestFeedIndex: feedIndex,
      lastActivityAt: now,
    };
    this.summaries.set(collabId, updated);
    this.persist();
    this.emit({ type: "collab-updated", collabId, data: updated });
    return updated;
  }

  /**
   * Initiator-only: add a participant.
   *
   * Resolves the new peer's profile, extends the ACT grantee chain via
   * patchGrantees (incremental — no rewrite), and publishes a new
   * manifest revision. The new participant receives a standard
   * invitation chat message pointing at the current bundle + manifest.
   */
  async addParticipant(collabId: CollabId, peerAddress: string): Promise<CollabSummary> {
    const summary = this.summaries.get(collabId);
    if (!summary) throw new Error(`Unknown collab: ${collabId}`);
    if (summary.initiator !== this.myAddress.toLowerCase()) {
      throw new Error("Only the collab initiator can add participants.");
    }
    const addr = peerAddress.toLowerCase();
    if (summary.participants.some((p) => p.address === addr)) {
      throw new Error(`Participant already in the collab: ${peerAddress}`);
    }
    const profile = await this.client.readPublicProfile(addr);
    if (!profile?.beeNodePublicKey) {
      throw new Error(
        `Participant ${peerAddress} has no public profile or Bee node pubkey — they need to connect to Swarm first.`,
      );
    }
    if (!summary.currentGranteeHistRef || !summary.currentGranteeRef) {
      throw new Error(
        "Collab is missing its current grantee chain — refreshManifest() first.",
      );
    }

    // Extend grantee chain (patch = incremental, no rebuild).
    const patched = await this.client.grantAccess(
      summary.currentGranteeRef,
      summary.currentGranteeHistRef,
      [profile.beeNodePublicKey],
    );
    await new Promise((r) => setTimeout(r, 1100));

    const now = new Date().toISOString();
    const newParticipant: CollabParticipant = {
      address: addr,
      beeNodePublicKey: profile.beeNodePublicKey,
      joinedAt: now,
      displayName: (profile as any).ensName ?? undefined,
    };
    const nextParticipants = [...summary.participants, newParticipant];
    const manifest: CollabManifest = {
      version: 1,
      collabId,
      kind: summary.kind,
      driveId: summary.driveId,
      documentId: summary.documentId,
      title: summary.title,
      participants: nextParticipants,
      initiator: summary.initiator,
      createdAt: summary.participants.find((p) => p.address === summary.initiator)?.joinedAt ?? now,
      updatedAt: now,
    };
    const { feedIndex } = await this.manifestFeed.publish(manifest, patched.historyRef);

    const updated: CollabSummary = {
      ...summary,
      participants: nextParticipants,
      currentGranteeRef: patched.ref,
      currentGranteeHistRef: patched.historyRef,
      manifestFeedIndex: feedIndex,
      lastActivityAt: now,
    };
    this.summaries.set(collabId, updated);
    this.persist();

    // Send the new participant a chat invitation so they know about it.
    try {
      const session = await this.chat.startSession(addr);
      const attachment: CollabInviteAttachment = {
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
    } catch (err) {
      console.warn(
        `[CollabManager] addParticipant: chat invite send failed (continuing):`,
        err instanceof Error ? err.message : err,
      );
    }

    this.emit({ type: "collab-updated", collabId, data: updated });
    return updated;
  }

  /**
   * Re-read the collab's manifest feed to pick up any participant changes
   * the initiator has published since we last looked. Updates the local
   * summary if a newer manifest index is available.
   *
   * Returns the post-refresh summary (unchanged if no newer index).
   */
  async refreshManifest(collabId: CollabId): Promise<CollabSummary | null> {
    const summary = this.summaries.get(collabId);
    if (!summary) return null;
    const latest = await this.manifestFeed.readLatest(
      collabId,
      summary.initiator,
      summary.manifestPublisherBeeNodePubKey,
    );
    if (!latest) return summary;
    if (
      summary.manifestFeedIndex != null &&
      latest.feedIndex <= summary.manifestFeedIndex
    ) {
      return summary; // nothing new
    }
    const updated: CollabSummary = {
      ...summary,
      participants: latest.manifest.participants,
      manifestFeedIndex: latest.feedIndex,
      title: latest.manifest.title ?? summary.title,
      lastActivityAt: new Date().toISOString(),
    };
    this.summaries.set(collabId, updated);
    this.persist();
    this.emit({ type: "collab-updated", collabId, data: updated });
    return updated;
  }

  /**
   * Accept a collab invitation received in chat. Downloads the initial
   * drive bundle via ACT, applies it to the local reactor, and records
   * the summary locally so the collab shows up in the Collaborate tab.
   */
  async accept(invite: CollabInviteAttachment): Promise<CollabSummary> {
    const { applyDocumentBundle } = await import("../plugin/sharing.js");

    // Download bundle with retry — Swarm chunks take a few seconds to
    // propagate after upload, matching the chat-share import behavior.
    const retryDelays = [0, 2000, 5000];
    let bundleData: Uint8Array | null = null;
    let lastErr: unknown;
    for (const delay of retryDelays) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        bundleData = await this.client.downloadFile(invite.initialBundleRef, {
          actPublisher: invite.initialBundlePublisherBeeNodePubKey,
          actHistoryAddress: invite.initialBundleActHistoryAddress,
          skipDecryption: true, // ACT already decrypted at the node
        });
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!bundleData) {
      throw new Error(
        `Could not download collab bundle: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      );
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
    const mySelf: CollabParticipant = {
      address: this.myAddress.toLowerCase(),
      beeNodePublicKey: myBeeNodePubKey,
      joinedAt: now,
    };

    // Try to read the authoritative participant list from the manifest
    // feed. It's written ACT-protected by the initiator under the same
    // grantee chain we're now a member of, so we can decrypt. Fall back
    // to the invite's (slimmer) participant list if the feed isn't
    // reachable yet (chunk not propagated).
    let participants: CollabParticipant[] | null = null;
    let manifestFeedIndex: number | undefined;
    try {
      const latest = await this.manifestFeed.readLatest(
        invite.collabId,
        invite.invitedBy,
        invite.manifestPublisherBeeNodePubKey,
      );
      if (latest) {
        // Ensure self is present — the manifest should list us, but if
        // the invite arrived on a stale manifest (edge case: initiator
        // invited us in a prior chain) patch self in.
        const listed = latest.manifest.participants.map((p) => ({
          ...p,
          address: p.address.toLowerCase(),
        }));
        const hasSelf = listed.some((p) => p.address === mySelf.address);
        participants = hasSelf ? listed : [...listed, mySelf];
        manifestFeedIndex = latest.feedIndex;
      }
    } catch (err) {
      console.warn(
        "[CollabManager] accept: manifest feed read failed, falling back to invite participants:",
        err instanceof Error ? err.message : err,
      );
    }
    if (!participants) {
      // Fallback: invite's slim list (only the initiator has a known
      // pubkey, others will have empty pubkeys until refreshManifest).
      const inviteParticipants: CollabParticipant[] = invite.participants.map((p) => ({
        address: p.address.toLowerCase(),
        beeNodePublicKey: p.address.toLowerCase() === invite.invitedBy.toLowerCase()
          ? invite.manifestPublisherBeeNodePubKey
          : "",
        joinedAt: now,
        displayName: p.displayName,
      }));
      participants = [
        mySelf,
        ...inviteParticipants.filter((p) => p.address !== mySelf.address),
      ];
    }

    const summary: CollabSummary = {
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
    };
    this.summaries.set(summary.collabId, summary);
    this.persist();
    void this.upsertUserManifestEntry(summary).catch((err) => {
      console.warn(
        "[CollabManager] accept: user-manifest write failed (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    });
    this.emit({ type: "collab-accepted", collabId: summary.collabId, data: summary });

    return summary;
  }

  /**
   * Stop participating in a collab on this device + strip the entry
   * from the user manifest so a fresh browser doesn't re-hydrate it.
   * The initiator's collab manifest feed is untouched — they still
   * list this user as a participant until they explicitly revoke.
   * Returns a promise so callers can await the manifest write.
   */
  async leave(collabId: CollabId): Promise<void> {
    const existing = this.summaries.get(collabId);
    if (!existing) return;
    this.summaries.delete(collabId);
    this.persist();
    try {
      await removeCollabFromUserManifest(this.client, this.myAddress, collabId);
    } catch (err) {
      console.warn(
        "[CollabManager] leave: user-manifest remove failed (local state already cleared):",
        err instanceof Error ? err.message : err,
      );
    }
    this.emit({ type: "collab-removed", collabId });
  }

  list(): CollabSummary[] {
    return Array.from(this.summaries.values()).sort((a, b) =>
      b.lastActivityAt.localeCompare(a.lastActivityAt),
    );
  }

  get(collabId: CollabId): CollabSummary | undefined {
    return this.summaries.get(collabId);
  }

  on(type: CollabEventType | "*", handler: CollabEventHandler): () => void {
    const wrapped: CollabEventHandler = (evt) => {
      if (type === "*" || evt.type === type) handler(evt);
    };
    this.handlers.add(wrapped);
    return () => this.handlers.delete(wrapped);
  }

  // ─── User-manifest integration (authoritative collab registry) ─

  private summaryToUserManifestEntry(s: CollabSummary): UserCollabEntry {
    return {
      collabId: s.collabId,
      kind: s.kind,
      driveId: s.driveId,
      documentId: s.documentId,
      title: s.title,
      role: s.initiator === this.myAddress.toLowerCase() ? "initiator" : "participant",
      initiator: s.initiator,
      manifestOwnerAddress: s.initiator,
      manifestPublisherBeeNodePubKey: s.manifestPublisherBeeNodePubKey,
      joinedAt:
        s.participants.find((p) => p.address === this.myAddress.toLowerCase())?.joinedAt
        ?? new Date().toISOString(),
      lastActivityAt: s.lastActivityAt,
    };
  }

  private async upsertUserManifestEntry(s: CollabSummary): Promise<void> {
    await ensureCollabInUserManifest(
      this.client,
      this.myAddress,
      this.summaryToUserManifestEntry(s),
    );
  }

  /**
   * Boot-time recovery: read the user manifest's `collabs` map and
   * reconstruct local summaries for any collab that isn't already in
   * localStorage. For each entry we pull the ACT-protected manifest
   * feed to get the live participant list.
   *
   * Non-fatal if any part fails — the user can still open the
   * Collaborate tab and re-join from a fresh invite.
   */
  private async rehydrateFromUserManifest(): Promise<void> {
    try {
      const registry = await listCollabsFromUserManifest(this.client, this.myAddress);
      const entries = Object.values(registry);
      if (entries.length === 0) return;
      let recovered = 0;
      for (const entry of entries) {
        if (this.summaries.has(entry.collabId)) continue;
        try {
          const latest = await this.manifestFeed.readLatest(
            entry.collabId,
            entry.manifestOwnerAddress,
            entry.manifestPublisherBeeNodePubKey,
          );
          if (!latest) {
            // Feed unreachable — maybe we've been revoked, maybe
            // chunks haven't propagated. Stash a pending summary so
            // the UI can show it; a later refreshManifest or retry
            // will promote it to active or mark it revoked.
            this.summaries.set(entry.collabId, {
              collabId: entry.collabId,
              kind: entry.kind,
              driveId: entry.driveId,
              documentId: entry.documentId,
              title: entry.title,
              initiator: entry.initiator,
              participants: [],
              manifestRef: "",
              manifestActHistoryAddress: "",
              manifestPublisherBeeNodePubKey: entry.manifestPublisherBeeNodePubKey,
              lastActivityAt: entry.lastActivityAt,
              status: "pending",
            });
            continue;
          }
          const m = latest.manifest;
          this.summaries.set(entry.collabId, {
            collabId: entry.collabId,
            kind: entry.kind,
            driveId: entry.driveId,
            documentId: entry.documentId,
            title: m.title ?? entry.title,
            initiator: m.initiator,
            participants: m.participants.map((p) => ({
              ...p,
              address: p.address.toLowerCase(),
            })),
            manifestRef: "",
            manifestActHistoryAddress: "",
            manifestPublisherBeeNodePubKey: entry.manifestPublisherBeeNodePubKey,
            manifestFeedIndex: latest.feedIndex,
            lastActivityAt: entry.lastActivityAt,
            status: "active",
          });
          recovered++;
        } catch (err) {
          console.warn(
            `[CollabManager] rehydrate skipped ${entry.collabId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      if (recovered > 0) {
        console.log(
          `[CollabManager] Rehydrated ${recovered} collab(s) from user manifest.`,
        );
        this.persist();
        this.emit({ type: "collab-updated", collabId: "*" as any });
      }
    } catch (err) {
      console.warn(
        "[CollabManager] rehydrate failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ─── Internal helpers ──────────────────────────────────────────

  private emit(event: CollabEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        console.warn("[CollabManager] event handler threw:", err);
      }
    }
  }

  private persist(): void {
    try {
      const raw = JSON.stringify(Array.from(this.summaries.values()));
      (globalThis as any).window?.localStorage?.setItem?.(LS_SUMMARIES_KEY, raw);
    } catch {
      /* localStorage unavailable */
    }
  }

  private loadFromStorage(): void {
    try {
      const raw = (globalThis as any).window?.localStorage?.getItem?.(LS_SUMMARIES_KEY);
      if (!raw) return;
      const list = JSON.parse(raw) as CollabSummary[];
      for (const s of list) this.summaries.set(s.collabId, s);
    } catch {
      /* ignore — corrupt or unavailable */
    }
  }

  /**
   * List doc IDs in a drive by reading the reactor's local state. Falls
   * back to an empty list if the reactor client isn't wired up.
   */
  private async listDocIdsInDrive(driveId: string): Promise<string[]> {
    const ph = (globalThis as any).window?.ph;
    const reactorClient = ph?.reactorClient;
    if (!reactorClient) return [];
    try {
      const drive = await reactorClient.get(driveId);
      const nodes = drive?.state?.global?.nodes ?? [];
      // Nodes are { id, kind: "file" | "folder", ... }; docs are "file" nodes.
      return nodes
        .filter((n: any) => n?.kind === "file" && typeof n?.id === "string")
        .map((n: any) => n.id as string);
    } catch {
      return [];
    }
  }

  // ─── Push hook: mirror local ops to collab feed ────────────────

  /**
   * Called by SwarmChannel after a successful push of local ops to the
   * user's personal doc feed. Mirrors the same batch to each active
   * collab's ACT-protected per-peer feed so other participants can see
   * the ops.
   *
   * Best-effort: errors are logged but don't fail the caller — the
   * personal-feed push already succeeded, the collab mirror is a
   * secondary write that can be retried on next push.
   */
  async handleLocalPush(input: {
    driveId: string;
    docId: string;
    ops: any[];
    scope: string;
    branch: string;
  }): Promise<void> {
    if (this.shuttingDown) return;
    if (!input.ops?.length) return;

    // Find all collabs that cover this doc. For drive-level collabs, every
    // doc in the drive counts. For doc-level collabs, only the specific doc.
    const relevant: CollabSummary[] = [];
    for (const s of this.summaries.values()) {
      if (s.driveId !== input.driveId) continue;
      if (s.kind === "document" && s.documentId !== input.docId) continue;
      relevant.push(s);
    }
    if (relevant.length === 0) return;

    const startIndex = input.ops[0]?.operation?.index ?? 0;
    const endIndex = input.ops[input.ops.length - 1]?.operation?.index ?? 0;

    for (const s of relevant) {
      try {
        // Ensure we have a grantee chain to write under. Initiator has
        // one from create(); joiners lazily create one on first push,
        // backfilling their own pubkey into the participant record.
        const granteeHistRef = await this.ensureGranteeChainForLocalWrite(s);
        if (!granteeHistRef) continue; // not enough info to mirror yet
        const batch: CollabOpsBatch = {
          opsJson: JSON.stringify(input.ops),
          startIndex,
          endIndex,
          scope: input.scope,
          branch: input.branch,
          timestamp: new Date().toISOString(),
        };
        await this.opsFeed.appendBatch(
          s.collabId,
          input.driveId,
          input.docId,
          batch,
          granteeHistRef,
        );
        const updated = { ...this.summaries.get(s.collabId)!, lastActivityAt: new Date().toISOString() };
        this.summaries.set(s.collabId, updated);
        this.persist();
      } catch (err) {
        console.warn(
          `[CollabManager] mirror push failed for ${s.collabId} doc ${input.docId.slice(0, 8)}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /**
   * Return a live ACT grantee-chain head for writes on this collab. For
   * the initiator this is just the summary's currentGranteeHistRef. For
   * joiners, this creates a chain the first time we write (lazy), using
   * the participant list from the manifest feed.
   */
  private async ensureGranteeChainForLocalWrite(s: CollabSummary): Promise<string | null> {
    if (s.currentGranteeHistRef) return s.currentGranteeHistRef;

    const known = s.participants.filter((p) => p.beeNodePublicKey);
    if (known.length < s.participants.length) {
      // Missing some pubkeys — try a manifest refresh first.
      const refreshed = await this.refreshManifest(s.collabId).catch(() => null);
      if (refreshed?.currentGranteeHistRef) return refreshed.currentGranteeHistRef;
      const newLive = refreshed ?? this.summaries.get(s.collabId) ?? s;
      const liveKeys = newLive.participants.map((p) => p.beeNodePublicKey).filter((k) => !!k);
      if (liveKeys.length < 2) return null;
      const { ref, historyRef } = await this.client.createGrantees(liveKeys);
      await new Promise((r) => setTimeout(r, 1100));
      const updated: CollabSummary = {
        ...newLive,
        currentGranteeRef: ref,
        currentGranteeHistRef: historyRef,
      };
      this.summaries.set(s.collabId, updated);
      this.persist();
      return historyRef;
    }

    const liveKeys = known.map((p) => p.beeNodePublicKey);
    if (liveKeys.length < 2) return null;
    const { ref, historyRef } = await this.client.createGrantees(liveKeys);
    await new Promise((r) => setTimeout(r, 1100));
    const updated: CollabSummary = {
      ...s,
      currentGranteeRef: ref,
      currentGranteeHistRef: historyRef,
    };
    this.summaries.set(s.collabId, updated);
    this.persist();
    return historyRef;
  }

  // ─── Poll loop: pull peers' ops and apply to local reactor ─────

  private startPolling(): void {
    if (this.pollTimer) return;
    // Run once shortly after boot, then periodically.
    setTimeout(() => { void this.pollOnce(); }, 1500);
    this.pollTimer = setInterval(() => { void this.pollOnce(); }, POLL_INTERVAL_MS);
  }

  private async pollOnce(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.pollInFlight) return;
    if (this.summaries.size === 0) return;
    this.pollInFlight = true;
    try {
      for (const summary of this.summaries.values()) {
        if (this.shuttingDown) break;
        await this.pollSummary(summary);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private async pollSummary(summary: CollabSummary): Promise<void> {
    const ph = (globalThis as any).window?.ph;
    const reactorClient = ph?.reactorClient;
    const reactor = ph?.reactor; // low-level reactor module — exposes load()
    if (!reactorClient) return;

    // Figure out which docs to poll. Drive-level = every doc currently in
    // the drive. Doc-level = just the one doc.
    const docIds = summary.kind === "document" && summary.documentId
      ? [summary.documentId]
      : await this.listDocIdsInDrive(summary.driveId);
    // Include the drive itself for drive-level ops (ADD_FOLDER, MOVE_NODE).
    if (summary.kind === "drive" && !docIds.includes(summary.driveId)) {
      docIds.unshift(summary.driveId);
    }

    let anyApplied = false;
    for (const docId of docIds) {
      for (const participant of summary.participants) {
        if (participant.address === this.myAddress.toLowerCase()) continue;
        if (!participant.beeNodePublicKey) continue;
        try {
          // Write path in handleLocalPush always passes a docId (even for
          // drive ops, docId === driveId), so the read path matches that
          // convention: always use the doc-scoped topic.
          const latest = await this.opsFeed.getLatestIndex(
            summary.collabId,
            summary.driveId,
            docId,
            participant.address,
          );
          if (latest == null) continue;
          const cursorKey = `${LS_PEER_CURSOR_PREFIX}${summary.collabId}:${participant.address}:${docId}`;
          const cursor = this.readCursor(cursorKey);
          if (latest < cursor) continue;
          const batches = await this.opsFeed.readRange(
            summary.collabId,
            summary.driveId,
            docId,
            participant.address,
            cursor,
            latest,
            participant.beeNodePublicKey,
          );
          if (batches.length === 0) continue;
          for (const { feedIndex, batch } of batches) {
            try {
              const raw = JSON.parse(batch.opsJson);
              if (!Array.isArray(raw) || raw.length === 0) continue;
              // SwarmChannel pushes OperationWithContext[] (each entry has
              // `.operation` + `.context`); reactor.load expects bare
              // Operation[]. Unwrap defensively — fall back to the entry
              // itself for already-flat payloads.
              const ops = raw.map((entry: any) => entry?.operation ?? entry);
              // Dispatch to the reactor. reactor.load() is idempotent per op
              // id, so re-runs from a re-pull don't corrupt state.
              if (reactor?.load) {
                await reactor.load(docId, batch.branch ?? "main", ops);
              } else if (reactorClient?.load) {
                await reactorClient.load(docId, batch.branch ?? "main", ops);
              } else {
                console.warn(
                  "[CollabManager] No reactor.load available, ops queued but not applied",
                );
                continue;
              }
              anyApplied = true;
              this.writeCursor(cursorKey, feedIndex + 1);
            } catch (err) {
              console.warn(
                `[CollabManager] apply ops failed (${summary.collabId}, doc ${docId.slice(0, 8)}, idx ${feedIndex}):`,
                err instanceof Error ? err.message : err,
              );
            }
          }
        } catch (err) {
          // Peer's feed may not exist yet (they haven't made any edits).
          // Keep walking — other peers / docs may be ahead.
          void err;
        }
      }
    }

    if (anyApplied) {
      const updated = { ...summary, lastActivityAt: new Date().toISOString() };
      this.summaries.set(summary.collabId, updated);
      this.persist();
      this.emit({ type: "op-applied", collabId: summary.collabId });
      // UI hook: fire a custom event so the toolbar History view can
      // refresh without having to subscribe to collab events.
      try {
        (globalThis as any).window?.dispatchEvent(
          new CustomEvent("swarm:collab:op-applied", {
            detail: { collabId: summary.collabId },
          }),
        );
      } catch { /* non-browser */ }
    }
  }

  private readCursor(key: string): number {
    try {
      const raw = (globalThis as any).window?.localStorage?.getItem?.(key);
      const n = raw ? parseInt(raw, 10) : 0;
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  private writeCursor(key: string, value: number): void {
    try {
      (globalThis as any).window?.localStorage?.setItem?.(key, String(value));
    } catch {
      /* localStorage unavailable */
    }
  }
}
