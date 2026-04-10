import { describe, it, expect } from "vitest";
import { createEmptyManifest } from "../../src/types.js";

describe("types", () => {
  describe("createEmptyManifest", () => {
    it("should create manifest with correct documentId and documentType", () => {
      const manifest = createEmptyManifest("doc-123", "powerhouse/budget-statement");
      expect(manifest.documentId).toBe("doc-123");
      expect(manifest.documentType).toBe("powerhouse/budget-statement");
    });

    it("should have empty arrays and object", () => {
      const manifest = createEmptyManifest("doc-1", "test/doc");
      expect(manifest.latestRevision).toEqual({});
      expect(manifest.operationBatches).toEqual([]);
      expect(manifest.keyframes).toEqual([]);
    });

    it("should set updatedAt to ISO timestamp", () => {
      const before = new Date().toISOString();
      const manifest = createEmptyManifest("doc-1", "test/doc");
      const after = new Date().toISOString();
      expect(manifest.updatedAt >= before).toBe(true);
      expect(manifest.updatedAt <= after).toBe(true);
    });

    it("should default documentType to empty string", () => {
      const manifest = createEmptyManifest("doc-1");
      expect(manifest.documentType).toBe("");
    });
  });
});
