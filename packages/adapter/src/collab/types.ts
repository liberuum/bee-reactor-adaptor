/**
 * Live collaboration types.
 *
 * A CollabManifest lists the participants of a drive- or document-level
 * collaboration. It lives on a Swarm feed owned by the initiator,
 * ACT-protected with every participant's Bee node pubkey as a grantee.
 *
 * Each participant writes their own ops to collab-scoped feeds keyed by
 * (participantSignerAddress, collabId, driveId[, documentId]). Every other
 * participant's SwarmChannel reads those feeds.
 */

/** Drive-level or doc-level collaboration. */
export type CollabKind = "drive" | "document";

/** Stable identifier: `"drive:<driveId>"` or `"doc:<driveId>:<documentId>"`. */
export type CollabId = string;

export interface CollabParticipant {
  /** Swarm signer address (lowercase hex with 0x prefix). */
  address: string;
  /** Bee node public key (compressed hex). Needed as ACT grantee. */
  beeNodePublicKey: string;
  /** ISO timestamp when this participant was added. */
  joinedAt: string;
  /** Optional display hint (ENS or profile name). */
  displayName?: string;
}

export interface CollabManifest {
  version: 1;
  collabId: CollabId;
  kind: CollabKind;
  driveId: string;
  /** Present only for `kind === "document"`. */
  documentId?: string;
  /** Human-readable title — drive or doc name at creation time. */
  title: string;
  /** Full participant list (including the initiator). */
  participants: CollabParticipant[];
  /** Swarm signer address of the initiator. Can't be removed. */
  initiator: string;
  createdAt: string;
  updatedAt: string;
  /** Freeform caption entered in the Collaborate picker. */
  caption?: string;
}

/**
 * Published on a chat message as an invitation. Points to the collab
 * manifest (ACT-protected) and to a one-shot bundle with the current
 * drive/doc state for the recipient's initial import.
 */
export interface CollabInviteAttachment {
  kind: "collab-invite";
  collabId: CollabId;
  collabKind: CollabKind;
  title: string;
  driveId: string;
  driveName: string;
  documentId?: string;
  documentName?: string;
  /** ACT-protected collab manifest. */
  manifestRef: string;
  manifestActHistoryAddress: string;
  manifestPublisherBeeNodePubKey: string;
  /** ACT-protected initial-state drive bundle (same shape as
   *  DocumentShareAttachment; lets accept reuse `importFromUser`). */
  initialBundleRef: string;
  initialBundleActHistoryAddress: string;
  initialBundlePublisherBeeNodePubKey: string;
  /** Snapshot of participants at invite time (informational — the
   *  authoritative list is the manifest). */
  participants: Array<{ address: string; displayName?: string }>;
  invitedBy: string;
  invitedAt: string;
  caption?: string;
}

/**
 * Local-only summary of an active collaboration. Persisted in
 * localStorage so sessions survive reload.
 */
export interface CollabSummary {
  collabId: CollabId;
  kind: CollabKind;
  driveId: string;
  documentId?: string;
  title: string;
  initiator: string;
  participants: CollabParticipant[];
  /** Swarm refs for the one-shot initial drive bundle (ACT-protected). */
  manifestRef: string;
  manifestActHistoryAddress: string;
  manifestPublisherBeeNodePubKey: string;
  /** Feed index of the latest manifest revision we know about. Used to
   *  detect new revisions on refresh and to compare membership changes. */
  manifestFeedIndex?: number;
  /** ACT grantee chain head covering the current participant set. Used
   *  by the owner of the collab op feeds (the writer) when appending new
   *  batches. Updated on every participant add/remove by the initiator,
   *  and by any participant learning a newer manifest from the feed. */
  currentGranteeHistRef?: string;
  /** The grantee ref returned alongside currentGranteeHistRef. Kept for
   *  future patchGrantees calls (incremental add/remove without
   *  rebuilding the whole list). */
  currentGranteeRef?: string;
  /** Most recent inbound op timestamp from any participant, or createdAt
   *  if nothing has arrived yet. Drives the "last activity" UI. */
  lastActivityAt: string;
  /** Per-peer activity state: last time we applied ops from them and
   *  cumulative count of ops we've applied in this session. Updated by
   *  `applyOpsAndAdvanceCursor`. Drives per-participant "active Xm ago"
   *  labels in the Manage panel + the collab-row counter. Keyed by
   *  lowercase peer address. Missing entry = no activity yet. */
  peerActivity?: Record<string, { lastAppliedAt: string; opsApplied: number }>;
  /** Bounded ring-buffer of recent collab events: joins, revokes,
   *  op-applied batches. Newest last. Drives the "Recent activity" feed
   *  in the Manage panel. Capped at RECENT_ACTIVITY_MAX so the summary
   *  doesn't balloon in localStorage for long-running collabs. */
  recentActivity?: CollabActivityEntry[];
  /** Populated as this client starts writing/reading collab feeds. */
  status: "active" | "pending" | "error" | "revoked";
}

/** Max entries retained per collab in recentActivity. Older entries
 *  fall off the front when new ones arrive. */
export const RECENT_ACTIVITY_MAX = 20;

/** One row in the "Recent activity" feed. Stored on the summary so a
 *  fresh browser shows state immediately from localStorage. */
export interface CollabActivityEntry {
  /** ISO timestamp. */
  at: string;
  kind:
    | "created"      // this client created the collab
    | "accepted"     // this client joined an invite
    | "left"         // this client left the collab
    | "participant-added"   // initiator added someone
    | "participant-revoked" // initiator revoked someone
    | "ops-applied";        // peer's ops were applied locally
  /** Who the event is about (peer address for ops/add/revoke). */
  actor?: string;
  /** Short summary for the UI. Optional; UI can recompute from the
   *  kind + actor + count when absent. */
  label?: string;
  /** Populated for `ops-applied`: how many operations were in the batch. */
  opsCount?: number;
  /** Populated for `ops-applied`: which doc received the ops. */
  docId?: string;
}

/** Adapter-level event stream for Connect's UI. */
export type CollabEventType =
  | "invite-received"
  | "collab-created"
  | "collab-accepted"
  | "collab-updated"
  | "collab-removed"
  | "op-applied";

export interface CollabEvent {
  type: CollabEventType;
  collabId: CollabId;
  data?: unknown;
}

export type CollabEventHandler = (event: CollabEvent) => void;

// ─── Swarm topic helpers ──────────────────────────────────────────

/** Stable string ID from kind + ids, used in feed topics + localStorage keys. */
export function buildCollabId(kind: CollabKind, driveId: string, documentId?: string): CollabId {
  if (kind === "document") {
    if (!documentId) throw new Error("document-kind collab requires documentId");
    return `doc:${driveId}:${documentId}`;
  }
  return `drive:${driveId}`;
}

/** Collaboration manifest feed — owned by the initiator. */
export function collabManifestTopic(collabId: CollabId): string {
  return `ph:v2:collab:${collabId}`;
}

/** Per-participant drive-level ops feed for a collab. */
export function collabDriveOpsTopic(collabId: CollabId, driveId: string): string {
  return `ph:v2:collab:${collabId}:ops:${driveId}`;
}

/** Per-participant document-level ops feed for a collab. */
export function collabDocOpsTopic(
  collabId: CollabId,
  driveId: string,
  documentId: string,
): string {
  return `ph:v2:collab:${collabId}:ops:${driveId}:${documentId}`;
}
