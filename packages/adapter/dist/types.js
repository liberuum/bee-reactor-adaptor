// ─── Utilities ──────────────────────────────────────────────────
/**
 * Create an empty document manifest.
 * Canonical factory — use this instead of inline object literals.
 */
export function createEmptyManifest(documentId, documentType = "") {
    return {
        documentId,
        documentType,
        latestRevision: {},
        operationBatches: [],
        keyframes: [],
        updatedAt: new Date().toISOString(),
    };
}
//# sourceMappingURL=types.js.map