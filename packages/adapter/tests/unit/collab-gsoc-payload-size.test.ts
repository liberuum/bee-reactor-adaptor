/**
 * Unit tests for the GSOC fast-path size checker.
 *
 * Pure function, no Bee node required.
 */
import { describe, it, expect } from "vitest";
import {
  checkOpsFit,
  INLINE_OPS_BUDGET,
  GSOC_WIRE_LIMIT,
} from "../../src/collab/gsoc-payload-size.js";

describe("GSOC payload size checker", () => {
  it("empty or missing ops → tier 'feed'", () => {
    expect(checkOpsFit(null).tier).toBe("feed");
    expect(checkOpsFit(undefined).tier).toBe("feed");
    expect(checkOpsFit([]).tier).toBe("feed");
  });

  it("small op (typical action) → tier 'inline'", () => {
    const ops = [
      {
        operation: {
          id: "abc-123",
          index: 0,
          skip: 0,
          timestampUtcMs: "2026-04-19T10:00:00.000Z",
          hash: "x".repeat(44),
          action: {
            id: "act-001",
            type: "SET_AUTHOR_NAME",
            timestampUtcMs: "2026-04-19T10:00:00.000Z",
            input: { name: "Alice" },
            scope: "global",
          },
        },
        context: {
          documentId: "doc-123",
          documentType: "powerhouse/document-model",
          scope: "global",
          branch: "main",
        },
      },
    ];
    const fit = checkOpsFit(ops);
    expect(fit.fits).toBe(true);
    expect(fit.tier).toBe("inline");
    expect(fit.size).toBeGreaterThan(0);
    expect(fit.size).toBeLessThan(INLINE_OPS_BUDGET);
  });

  it("batch of ~5 small ops → tier 'inline' (typical edit burst)", () => {
    const ops = Array.from({ length: 5 }, (_, i) => ({
      operation: {
        id: `op-${i}`,
        index: i,
        skip: 0,
        timestampUtcMs: "2026-04-19T10:00:00.000Z",
        hash: "x".repeat(44),
        action: {
          id: `act-${i}`,
          type: "SET_STATE_SCHEMA",
          timestampUtcMs: "2026-04-19T10:00:00.000Z",
          input: { schema: "type X { a: Int b: String }" },
          scope: "global",
        },
      },
      context: {
        documentId: "doc-batch",
        documentType: "powerhouse/document-model",
        scope: "global",
        branch: "main",
      },
    }));
    const fit = checkOpsFit(ops);
    expect(fit.tier).toBe("inline");
    expect(fit.size).toBeLessThan(INLINE_OPS_BUDGET);
  });

  it("op carrying a large paste (~10KB string) → tier 'refs'", () => {
    const ops = [
      {
        operation: {
          id: "big-paste",
          index: 0,
          action: {
            type: "PASTE_STATE",
            input: { blob: "y".repeat(10_000) },
            scope: "global",
          },
        },
        context: { documentId: "doc-big", scope: "global", branch: "main" },
      },
    ];
    const fit = checkOpsFit(ops);
    expect(fit.fits).toBe(false);
    expect(fit.tier).toBe("refs");
    expect(fit.size).toBeGreaterThan(INLINE_OPS_BUDGET);
    expect(fit.size).toBeGreaterThan(GSOC_WIRE_LIMIT);
  });

  it("edge: exactly at budget → inline; one byte over → refs", () => {
    // Build a single op whose serialized size lands close to the
    // budget, then toggle filler to straddle.
    const shell = {
      operation: {
        id: "edge",
        index: 0,
        action: {
          type: "PASTE",
          input: { s: "" },
          scope: "global",
        },
      },
      context: { documentId: "d", scope: "global", branch: "main" },
    };
    const overhead = JSON.stringify({ ops: [shell], scope: "global", branch: "main" }).length;
    const fillerLen = INLINE_OPS_BUDGET - overhead;
    const fits = checkOpsFit([{
      ...shell,
      operation: {
        ...shell.operation,
        action: { ...shell.operation.action, input: { s: "z".repeat(fillerLen) } },
      },
    }]);
    expect(fits.tier).toBe("inline");

    const doesntFit = checkOpsFit([{
      ...shell,
      operation: {
        ...shell.operation,
        action: { ...shell.operation.action, input: { s: "z".repeat(fillerLen + 10) } },
      },
    }]);
    expect(doesntFit.tier).toBe("refs");
  });

  it("budget is conservative vs the wire limit", () => {
    // Sanity: we always leave headroom for envelope + refs fallback.
    expect(INLINE_OPS_BUDGET).toBeLessThan(GSOC_WIRE_LIMIT);
    expect(GSOC_WIRE_LIMIT - INLINE_OPS_BUDGET).toBeGreaterThanOrEqual(500);
  });
});
