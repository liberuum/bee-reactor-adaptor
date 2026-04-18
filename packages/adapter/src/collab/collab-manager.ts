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
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private shuttingDown = false;

  constructor(
    private readonly client: SwarmClient,
    private readonly chat: ChatManager,
    private readonly myAddress: string,
  ) {
    this.opsFeed = new CollabOpsFeed(client);
    this.loadFromStorage();
    this.startPolling();
    // Install the push hook so SwarmChannel can notify us on every local
    // op flush. Stable global so channels created before this manager
    // (cold start, HMR) can still find it lazily.
    (globalThis as any).__swarmCollabManager__ = this;
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

    // 3. Upload the bundle under ONE ACT chain with ALL participants as
    //    grantees. Every participant's Bee node can decrypt the same ref.
    const myBeeNodePubKey = await this.client.getBeeNodePublicKey();
    const granteeKeys = [
      myBeeNodePubKey,
      ...participantProfiles.map((p) => p.beeNodePublicKey),
    ];
    const { ref: granteeRef, historyRef } = await this.client.createGrantees(granteeKeys);
    const { reference: bundleRef, historyAddress } = await this.client.uploadFile(
      JSON.stringify(built.bundle),
      {
        act: true,
        actHistoryAddress: historyRef,
        skipEncryption: true, // ACT handles it
      },
    );
    const bundleActHistoryAddress = historyAddress ?? historyRef;
    void granteeRef; // kept locally; future revocation work uses this ref

    // 4. Build the local summary.
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

    const summary: CollabSummary = {
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
      const attachment: CollabInviteAttachment = {
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

    // Reconstruct participants from the invite + ensure self is present.
    const inviteParticipants: CollabParticipant[] = invite.participants.map((p) => ({
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
    const participants: CollabParticipant[] = [
      mySelf,
      ...inviteParticipants.filter((p) => p.address !== mySelf.address),
    ];

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
  leave(collabId: CollabId): void {
    const existing = this.summaries.get(collabId);
    if (!existing) return;
    this.summaries.delete(collabId);
    this.persist();
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
        const granteeKeys = s.participants
          .map((p) => p.beeNodePublicKey)
          .filter((k) => !!k);
        if (granteeKeys.length < 2) {
          // Participant list is incomplete (e.g. accepted invite with no
          // bee pubkey for the initiator) — skip mirror until the
          // participant list gets refreshed on next invite exchange.
          continue;
        }
        const batch: CollabOpsBatch = {
          opsJson: JSON.stringify(input.ops),
          startIndex,
          endIndex,
          scope: input.scope,
          branch: input.branch,
          timestamp: new Date().toISOString(),
        };
        // Doc-level collab writes to a doc-scoped topic; drive-level writes
        // to a doc-scoped topic as well, so every doc gets its own feed
        // inside the drive collab. This keeps reads parallelizable per doc.
        await this.opsFeed.appendBatch(
          s.collabId,
          input.driveId,
          input.docId,
          batch,
          granteeKeys,
        );
        const updated = { ...s, lastActivityAt: new Date().toISOString() };
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
          const latest = await this.opsFeed.getLatestIndex(
            summary.collabId,
            summary.driveId,
            docId === summary.driveId ? summary.driveId : docId,
            participant.address,
          );
          if (latest == null) continue;
          const cursorKey = `${LS_PEER_CURSOR_PREFIX}${summary.collabId}:${participant.address}:${docId}`;
          const cursor = this.readCursor(cursorKey);
          if (latest < cursor) continue;
          const batches = await this.opsFeed.readRange(
            summary.collabId,
            summary.driveId,
            docId === summary.driveId ? summary.driveId : docId,
            participant.address,
            cursor,
            latest,
            participant.beeNodePublicKey,
          );
          if (batches.length === 0) continue;
          for (const { feedIndex, batch } of batches) {
            try {
              const ops = JSON.parse(batch.opsJson);
              if (!Array.isArray(ops) || ops.length === 0) continue;
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
