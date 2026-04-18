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
  /** Swarm refs needed to reread/refresh the manifest later. */
  manifestRef: string;
  manifestActHistoryAddress: string;
  manifestPublisherBeeNodePubKey: string;
  /** Most recent inbound op timestamp from any participant, or createdAt
   *  if nothing has arrived yet. Drives the "last activity" UI. */
  lastActivityAt: string;
  /** Populated as this client starts writing/reading collab feeds. */
  status: "active" | "pending" | "error";
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
