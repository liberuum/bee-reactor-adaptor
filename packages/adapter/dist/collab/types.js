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
// ─── Swarm topic helpers ──────────────────────────────────────────
/** Stable string ID from kind + ids, used in feed topics + localStorage keys. */
export function buildCollabId(kind, driveId, documentId) {
    if (kind === "document") {
        if (!documentId)
            throw new Error("document-kind collab requires documentId");
        return `doc:${driveId}:${documentId}`;
    }
    return `drive:${driveId}`;
}
/** Collaboration manifest feed — owned by the initiator. */
export function collabManifestTopic(collabId) {
    return `ph:v2:collab:${collabId}`;
}
/** Per-participant drive-level ops feed for a collab. */
export function collabDriveOpsTopic(collabId, driveId) {
    return `ph:v2:collab:${collabId}:ops:${driveId}`;
}
/** Per-participant document-level ops feed for a collab. */
export function collabDocOpsTopic(collabId, driveId, documentId) {
    return `ph:v2:collab:${collabId}:ops:${driveId}:${documentId}`;
}
//# sourceMappingURL=types.js.map