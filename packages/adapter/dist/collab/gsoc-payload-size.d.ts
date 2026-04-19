/**
 * GSOC payload size utilities.
 *
 * GSOC messages are SOC-backed — the hard wire limit is 4096 bytes per
 * tests/integration/gsoc-payload-size.test.ts (4064B accepted, 4096B
 * accepted, 8192B rejected with "payload size 8190 exceeds limits
 * [1, 4096]").
 *
 * On top of that, bee-js adds encoding overhead (~100B for framing +
 * signature + identifier) and our notification envelope costs ~200B
 * for type/from/timestamp/data keys + refs fallback fields.
 *
 * INLINE_OPS_BUDGET is the max serialized JSON length of the ops blob
 * that still leaves headroom for the rest of the ping. If your ops
 * serialize under this, they inline into the ping as a zero-RTT fast
 * path. Over it, the ping carries only refs + the feed is the source
 * of truth for catch-up.
 */
/** Absolute wire limit for a GSOC payload. Hard-confirmed empirically. */
export declare const GSOC_WIRE_LIMIT = 4096;
/** Safe budget for an inlined ops blob inside our op-committed notification. */
export declare const INLINE_OPS_BUDGET = 3400;
export interface OpsFitCheck {
    /** True when ops fit the GSOC inline budget. */
    fits: boolean;
    /** Serialized JSON byte length of the ops blob. */
    size: number;
    /** Byte budget compared against. */
    budget: number;
    /** Tier decided: "inline" fits, "refs" over budget (fall back to /bzz refs), "feed" nothing to send (no write result yet). */
    tier: "inline" | "refs" | "feed";
}
/**
 * Inspect a proposed ops blob and decide which GSOC fast-path tier it
 * qualifies for.
 *
 * Receivers handle each tier automatically:
 *   - inline: ops are in the ping → apply immediately (~1s cross-node).
 *   - refs:   ping carries actRef/actHistoryAddress → receiver
 *             downloads the batch via /bzz directly (~3s cross-node),
 *             skipping the feed read.
 *   - feed:   no ping → next poll tick reads the feed (~5-30s).
 *
 * Pure, synchronous, side-effect free — safe to call during every
 * handleLocalPush tick, and unit-testable without a Bee node.
 */
export declare function checkOpsFit(ops: readonly unknown[] | null | undefined, scope?: string, branch?: string): OpsFitCheck;
//# sourceMappingURL=gsoc-payload-size.d.ts.map