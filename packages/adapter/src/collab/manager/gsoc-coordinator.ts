/**
 * GsocCoordinator — owns everything about the GSOC transport for a
 * collab:
 *
 *   • Mines one signer per (collab, peer) pair targeting the peer's
 *     overlay neighbourhood and advertises the resulting listen address
 *     on the sender's public profile.
 *   • Subscribes to each peer's advertised outbound-to-me channel so we
 *     hear their pings.
 *   • Dispatches incoming pings to `ApplyPipeline` (inline / refs fast
 *     paths) or to `pollKick` (fallback) and handles the "collab-join"
 *     announce ping that seeds `peerActivity`.
 *   • Sends outbound pings — both op-committed (`doc-updated`, with the
 *     three-tier inline/refs/feed fast path) and the one-shot
 *     announce-only `collab-join`.
 */

import type { SwarmClient } from "../../swarm-client.js";
import { GsocNotifier } from "../../chat/gsoc-notifier.js";
import type { SwarmPublicProfile } from "../../types.js";
import type {
  CollabId,
  CollabParticipant,
  CollabSummary,
} from "../types.js";
import { checkOpsFit } from "../gsoc-payload-size.js";
import type { ApplyPipeline, PollKick } from "./apply-pipeline.js";
import { collabGsocIdentifier } from "./constants.js";
import type { CollabEventBus } from "./event-bus.js";
import { dispatchWindowEvent } from "./reactor-bridge.js";
import { pushActivity, SummaryStore } from "./store.js";

interface MinedOutbound {
  signerHex: string;
  identifierHex: string;
}

export interface OpCommittedWrite {
  actRef: string;
  actHistoryAddress: string;
  feedIndex: number;
  /** Raw OperationWithContext[] — will be inlined if the ping fits.
   *  Readonly because the caller shouldn't mutate it and we don't. */
  ops?: readonly unknown[];
  scope?: string;
  branch?: string;
}

export class GsocCoordinator {
  /** Per-peer mined signer: key `<collabId>:<peerAddress>`, value
   *  { signerHex, identifierHex } — stable for the life of the collab. */
  private readonly outbound = new Map<string, MinedOutbound>();
  /** Subscription cancel handles for inbound pings. Key:
   *  `<collabId>:<peerAddress>`. */
  private readonly inboundSubs = new Map<string, () => void>();
  /** Per-subscription deduper — set when we've either subscribed OR
   *  failed so rehydrate won't loop on unreachable peers. Cleared on
   *  retryable failures so the next rehydrate tick can try again. */
  private readonly subscribedPeers = new Set<string>();

  constructor(
    private readonly client: SwarmClient,
    private readonly myAddress: string,
    /** May be null in unit tests or pre-init — all ping paths no-op. */
    private readonly gsoc: GsocNotifier | null,
    private readonly store: SummaryStore,
    private readonly events: CollabEventBus,
    private readonly applyPipeline: ApplyPipeline,
    private readonly pollKick: PollKick,
  ) {}

  shutdown(): void {
    for (const cancel of this.inboundSubs.values()) {
      try { cancel(); } catch { /* ignore */ }
    }
    this.inboundSubs.clear();
  }

  // ─── Outbound: mine + advertise ────────────────────────────────

  /**
   * Mine a signer per peer for a collab, remember the listen address,
   * and merge the outbound-to-peer map into our public profile so peers
   * can find where to subscribe. Best-effort: failures are logged but
   * not thrown — the poll-loop fallback still delivers ops.
   *
   * Idempotent per (collabId, peerAddress): subsequent calls reuse the
   * cached mined signer.
   */
  async provisionOutbound(
    collabId: CollabId,
    peers: CollabParticipant[],
  ): Promise<void> {
    if (!this.gsoc || peers.length === 0) return;

    let profile: SwarmPublicProfile | null = null;
    try {
      profile = await this.client.readPublicProfile(this.myAddress);
    } catch { /* no profile yet */ }
    if (!profile) {
      // No profile published yet — bail. The plugin publishes one on
      // connect; a later provisionOutbound call will catch up.
      return;
    }

    const existingMap = { ...(profile.collabGsocOutbound ?? {}) };
    const collabMap = { ...(existingMap[collabId] ?? {}) };
    let profileDirty = false;

    for (const peer of peers) {
      if (this.isSelf(peer.address)) continue;
      const key = keyFor(collabId, peer.address);
      if (this.outbound.has(key) && collabMap[peer.address]) continue;

      const overlay = await this.lookupOverlay(peer.address);
      if (!overlay) continue;

      try {
        const identifierRaw = collabGsocIdentifier(this.myAddress, collabId);
        const { signerHex, listenAddress, identifierHex } =
          this.gsoc.mineSignerWithIdentifier(overlay, identifierRaw);
        this.outbound.set(key, { signerHex, identifierHex });
        if (collabMap[peer.address] !== listenAddress) {
          collabMap[peer.address] = listenAddress;
          profileDirty = true;
        }
      } catch (err) {
        console.warn(
          `[CollabManager] mine for ${collabId} peer ${peer.address.slice(0, 10)} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (!profileDirty) return;
    existingMap[collabId] = collabMap;
    try {
      await this.client.publishPublicProfile(this.myAddress, {
        ...profile,
        collabGsocOutbound: existingMap,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(
        "[CollabManager] publishPublicProfile for collab GSOC addrs failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ─── Inbound: subscribe to each peer ────────────────────────────

  /**
   * Subscribe to each peer's advertised outbound-to-me GSOC address for
   * a given collab, if we haven't already. Called lazily after mining
   * completes and on rehydrate.
   */
  async subscribeToPeers(summary: CollabSummary): Promise<void> {
    if (!this.gsoc) return;
    for (const peer of summary.participants) {
      if (this.isSelf(peer.address)) continue;
      const subKey = keyFor(summary.collabId, peer.address);
      if (this.subscribedPeers.has(subKey)) continue;
      this.subscribedPeers.add(subKey);

      try {
        const peerProfile = await this.client.readPublicProfile(peer.address);
        const listenAddress = peerProfile?.collabGsocOutbound?.[summary.collabId]?.[this.myAddress.toLowerCase()];
        if (!listenAddress) {
          // Peer hasn't advertised an outbound-to-me GSOC address for
          // this collab yet. Drop from the dedup set so a later
          // subscribe attempt can retry when they publish.
          this.subscribedPeers.delete(subKey);
          continue;
        }
        const identifierRaw = collabGsocIdentifier(peer.address, summary.collabId);
        const identifierHex = GsocNotifier.hashIdentifier(identifierRaw);
        const subscription = this.gsoc.subscribeWithIdentifier(
          subKey,
          listenAddress,
          identifierHex,
          {
            // Look up the summary fresh on each ping — the captured
            // `summary` snapshot is stale after revoke/add, and we
            // want to react against the current participant list.
            onNotification: (n) => this.handlePing(
              this.store.get(summary.collabId) ?? summary,
              peer.address,
              n,
            ),
            onError: (err) => {
              console.warn(
                `[CollabManager] GSOC subscribe error for ${subKey}:`,
                err.message,
              );
            },
          },
        );
        this.inboundSubs.set(subKey, () => subscription.cancel());

        // Publishing an outbound-to-me address means the peer has gone
        // through their accept flow (provisionOutbound only runs on
        // create/accept/rehydrate). That's our "they joined" proof —
        // flip peerActivity so the initiator's UI stops showing
        // "Awaiting" without depending on a potentially-lost
        // `collab-join` ping.
        this.markPeerJoined(summary.collabId, peer.address);
      } catch (err) {
        this.subscribedPeers.delete(subKey);
        console.warn(
          `[CollabManager] subscribe to GSOC for ${subKey} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // ─── Outbound: send pings ───────────────────────────────────────

  /**
   * Send op-committed pings to every OTHER participant for a collab.
   *
   * Three-tier fast path:
   *   1. **Inline ops** — if the serialized ops fit within the GSOC
   *      4KB chunk budget, embed them in the ping (sub-second apply,
   *      zero Swarm fetches).
   *   2. **Refs only** — always include `actRef + actHistoryAddress +
   *      feedIndex` so a receiver whose ping exceeded the inline budget
   *      can download the batch via /bzz directly.
   *   3. **Feed** — the actual feed write happens in the push path.
   *      Receivers who missed the ping entirely fall back to the poll
   *      loop that reads the feed.
   */
  async pingOpCommitted(
    summary: CollabSummary,
    driveId: string,
    docId: string,
    write?: OpCommittedWrite,
  ): Promise<void> {
    if (!this.gsoc) return;
    const myBeeNodePubKey = await this.client.getBeeNodePublicKey().catch(() => "");

    const fit = checkOpsFit(write?.ops, write?.scope, write?.branch);
    const inlineable =
      fit.fits && write
        ? {
            ops: write.ops!,
            scope: write.scope ?? "global",
            branch: write.branch ?? "main",
          }
        : null;
    if (write?.ops?.length) {
      console.log(
        `[CollabManager] ping ${summary.collabId} tier=${fit.tier} (${fit.size}B / ${fit.budget}B budget)`,
      );
    }

    for (const peer of summary.participants) {
      if (this.isSelf(peer.address)) continue;
      const mined = this.outbound.get(keyFor(summary.collabId, peer.address));
      if (!mined) continue; // haven't mined yet — next push will catch up
      try {
        await this.gsoc.sendWithSigner(
          mined.signerHex,
          mined.identifierHex,
          "doc-updated",
          {
            collabId: summary.collabId,
            writerAddress: this.myAddress.toLowerCase(),
            driveId,
            documentId: docId,
            ...(write
              ? {
                  actRef: write.actRef,
                  actHistoryAddress: write.actHistoryAddress,
                  feedIndex: write.feedIndex,
                  publisherBeeNodePubKey: myBeeNodePubKey,
                }
              : {}),
            ...(inlineable
              ? {
                  inlineOps: inlineable.ops,
                  inlineScope: inlineable.scope,
                  inlineBranch: inlineable.branch,
                }
              : {}),
          },
        );
      } catch (err) {
        console.warn(
          `[CollabManager] GSOC ping to ${peer.address.slice(0, 10)} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /**
   * Fire a best-effort "collab-join" announce ping to every peer. Lets
   * peers already in the collab flip their "Awaiting" indicator to
   * joined without needing our first edit to land. Called from accept()
   * after `provisionOutbound` resolves so the outbound signers are mined.
   */
  async broadcastJoined(summary: CollabSummary): Promise<void> {
    if (!this.gsoc) return;
    for (const peer of summary.participants) {
      if (this.isSelf(peer.address)) continue;
      const mined = this.outbound.get(keyFor(summary.collabId, peer.address));
      if (!mined) continue;
      try {
        await this.gsoc.sendWithSigner(
          mined.signerHex,
          mined.identifierHex,
          "collab-join",
          {
            collabId: summary.collabId,
            writerAddress: this.myAddress.toLowerCase(),
          },
        );
      } catch (err) {
        console.warn(
          `[CollabManager] joined ping to ${peer.address.slice(0, 10)} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // ─── Inbound dispatch ───────────────────────────────────────────

  /**
   * Dispatch an incoming GSOC notification for a collab. Public so
   * unit tests can simulate pings without standing up a real Swarm
   * subscription; production callers reach here via the
   * `subscribeWithIdentifier` callback wired up in `subscribeToPeers`.
   */
  handlePing(
    summary: CollabSummary,
    writerAddress: string,
    notification: unknown,
  ): void {
    const n = notification as {
      type?: string;
      data?: {
        collabId?: string;
        writerAddress?: string;
        driveId?: string;
        documentId?: string;
        actRef?: string;
        actHistoryAddress?: string;
        feedIndex?: number;
        publisherBeeNodePubKey?: string;
        inlineOps?: unknown[];
        inlineScope?: string;
        inlineBranch?: string;
      };
    } | undefined;

    const collabId = n?.data?.collabId ?? summary.collabId;
    const writer = (n?.data?.writerAddress ?? writerAddress).toLowerCase();
    if (collabId !== summary.collabId) return;

    // Announce-only ping — bump peerActivity and bail. No fetch work.
    if (n?.type === "collab-join") {
      this.markPeerJoined(summary.collabId, writer);
      return;
    }

    const d = n?.data;
    const hasInline =
      Array.isArray(d?.inlineOps) && d!.inlineOps!.length > 0 && !!d?.documentId;
    const hasRefs =
      !!d?.actRef &&
      !!d?.actHistoryAddress &&
      !!d?.publisherBeeNodePubKey &&
      !!d?.driveId &&
      !!d?.documentId &&
      d?.feedIndex !== undefined;

    if (hasInline) {
      void this.applyPipeline.applyInlineOps(summary, writer, {
        ops: d!.inlineOps!,
        docId: d!.documentId!,
        scope: d!.inlineScope ?? "global",
        branch: d!.inlineBranch ?? "main",
        feedIndex: d!.feedIndex,
      });
    } else if (hasRefs) {
      void this.applyPipeline.applyFromPing(summary, writer, {
        actRef: d!.actRef!,
        actHistoryAddress: d!.actHistoryAddress!,
        feedIndex: d!.feedIndex!,
        publisherBeeNodePubKey: d!.publisherBeeNodePubKey!,
        driveId: d!.driveId!,
        docId: d!.documentId!,
      });
    } else {
      // Legacy / stripped ping — poll-loop will pick it up.
      this.pollKick();
    }
  }

  /**
   * Record that a peer announced themselves via "collab-join". Seeds
   * `peerActivity` so the Manage panel can show "joined Xs ago"
   * without waiting for their first op. No-op if we already have
   * activity for this peer — real ops are strictly more informative.
   */
  private markPeerJoined(collabId: CollabId, writer: string): void {
    const summary = this.store.get(collabId);
    if (!summary) return;
    const writerKey = writer.toLowerCase();
    if (summary.peerActivity?.[writerKey]) return;

    const now = new Date().toISOString();
    const updated: CollabSummary = {
      ...summary,
      lastActivityAt: now,
      peerActivity: {
        ...(summary.peerActivity ?? {}),
        [writerKey]: { lastAppliedAt: now, opsApplied: 0 },
      },
      recentActivity: pushActivity(summary.recentActivity, {
        at: now,
        kind: "participant-added",
        actor: writerKey,
        label: "joined",
      }),
    };
    this.store.set(collabId, updated);
    this.events.emit({ type: "collab-updated", collabId, data: updated });
    dispatchWindowEvent("swarm:collab:updated", { collabId });
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private isSelf(addr: string): boolean {
    return addr === this.myAddress.toLowerCase();
  }

  private async lookupOverlay(peerAddress: string): Promise<string | undefined> {
    try {
      const p = await this.client.readPublicProfile(peerAddress);
      return p?.overlayAddress;
    } catch {
      return undefined;
    }
  }
}

function keyFor(collabId: CollabId, peerAddress: string): string {
  return `${collabId}:${peerAddress}`;
}
