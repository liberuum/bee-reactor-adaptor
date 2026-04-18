/**
 * Unit tests for the small shared helpers consumed by CollabOpsFeed +
 * CollabManifestFeed.
 */
import { describe, it, expect } from "vitest";
import {
  WRAPPER_BYTES,
  parseFeedIndex,
  hexToBytes32,
  bytes32ToHex,
} from "../../src/collab/feed-bytes.js";

describe("feed-bytes", () => {
  it("WRAPPER_BYTES is 64 (actRef 32 + actHist 32)", () => {
    expect(WRAPPER_BYTES).toBe(64);
  });

  describe("parseFeedIndex", () => {
    it("handles number input", () => {
      expect(parseFeedIndex(0)).toBe(0);
      expect(parseFeedIndex(42)).toBe(42);
    });

    it("handles hex string input (both with and without 0x)", () => {
      expect(parseFeedIndex("0x05")).toBe(5);
      expect(parseFeedIndex("05")).toBe(5);
      expect(parseFeedIndex("0000000000000002")).toBe(2);
    });

    it("handles FeedIndex-like objects via toBigInt()", () => {
      const fakeFeedIndex = { toBigInt: () => BigInt(7) };
      expect(parseFeedIndex(fakeFeedIndex)).toBe(7);
    });

    it("falls back through toString when toBigInt is missing", () => {
      const stringLike = { toString: () => "0000000000000003" };
      expect(parseFeedIndex(stringLike)).toBe(3);
    });

    it("returns 0 for null / undefined / non-parseable input", () => {
      expect(parseFeedIndex(null)).toBe(0);
      expect(parseFeedIndex(undefined)).toBe(0);
      expect(parseFeedIndex("not-hex")).toBe(0);
      expect(parseFeedIndex({})).toBe(0);
    });

    it("returns 0 when toBigInt throws (unusual wrappers)", () => {
      const brokenFeedIndex = { toBigInt: () => { throw new Error("oops"); } };
      expect(parseFeedIndex(brokenFeedIndex)).toBe(0);
    });
  });

  describe("hexToBytes32 / bytes32ToHex roundtrip", () => {
    it("roundtrips a 32-byte value", () => {
      const hex = "ab".repeat(32);
      const bytes = hexToBytes32(hex);
      expect(bytes.length).toBe(32);
      expect(bytes[0]).toBe(0xab);
      expect(bytes32ToHex(bytes)).toBe(hex);
    });

    it("accepts 0x prefix and strips it", () => {
      const hex = "0x" + "cd".repeat(32);
      const bytes = hexToBytes32(hex);
      expect(bytes[0]).toBe(0xcd);
      expect(bytes32ToHex(bytes)).toBe("cd".repeat(32));
    });

    it("rejects non-32-byte hex", () => {
      expect(() => hexToBytes32("ab".repeat(16))).toThrow();
      expect(() => hexToBytes32("ab".repeat(40))).toThrow();
    });

    it("bytes32ToHex reads from offset (wrapper unpacking)", () => {
      const combined = new Uint8Array(64);
      combined.set(hexToBytes32("aa".repeat(32)), 0);
      combined.set(hexToBytes32("bb".repeat(32)), 32);
      expect(bytes32ToHex(combined, 0)).toBe("aa".repeat(32));
      expect(bytes32ToHex(combined, 32)).toBe("bb".repeat(32));
    });

    it("produces zero-padded hex for bytes below 0x10", () => {
      const bytes = new Uint8Array(32);
      bytes[0] = 0x01;
      bytes[31] = 0x0f;
      const hex = bytes32ToHex(bytes);
      expect(hex.startsWith("01")).toBe(true);
      expect(hex.endsWith("0f")).toBe(true);
      expect(hex.length).toBe(64);
    });
  });
});
