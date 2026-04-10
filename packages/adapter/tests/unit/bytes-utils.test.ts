import { describe, it, expect } from "vitest";
import { hexToBytes, bytesToHex, concatBytes } from "../../src/bytes-utils.js";

describe("bytes-utils", () => {
  describe("hexToBytes", () => {
    it("should convert hex string to bytes", () => {
      const bytes = hexToBytes("deadbeef");
      expect(bytes).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    });

    it("should handle 0x prefix", () => {
      const bytes = hexToBytes("0xdeadbeef");
      expect(bytes).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    });

    it("should handle empty string", () => {
      expect(hexToBytes("")).toEqual(new Uint8Array([]));
      expect(hexToBytes("0x")).toEqual(new Uint8Array([]));
    });

    it("should handle 32-byte key (64 hex chars)", () => {
      const hex = "aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344";
      const bytes = hexToBytes(hex);
      expect(bytes.length).toBe(32);
      expect(bytes[0]).toBe(0xaa);
      expect(bytes[31]).toBe(0x44);
    });
  });

  describe("bytesToHex", () => {
    it("should convert bytes to hex string (no 0x prefix)", () => {
      const hex = bytesToHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
      expect(hex).toBe("deadbeef");
    });

    it("should handle empty array", () => {
      expect(bytesToHex(new Uint8Array([]))).toBe("");
    });

    it("should pad single-digit hex values", () => {
      const hex = bytesToHex(new Uint8Array([0, 1, 15]));
      expect(hex).toBe("00010f");
    });
  });

  describe("hexToBytes <-> bytesToHex roundtrip", () => {
    it("should roundtrip arbitrary hex", () => {
      const original = "0123456789abcdef";
      const bytes = hexToBytes(original);
      const back = bytesToHex(bytes);
      expect(back).toBe(original);
    });

    it("should roundtrip 32-byte key", () => {
      const original = "aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344";
      expect(bytesToHex(hexToBytes(original))).toBe(original);
    });

    it("should roundtrip with 0x prefix (stripped on output)", () => {
      const bytes = hexToBytes("0xdeadbeef");
      expect(bytesToHex(bytes)).toBe("deadbeef");
    });
  });

  describe("concatBytes", () => {
    it("should concatenate multiple arrays", () => {
      const a = new Uint8Array([1, 2]);
      const b = new Uint8Array([3, 4]);
      const c = new Uint8Array([5]);
      expect(concatBytes(a, b, c)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    it("should handle empty arrays", () => {
      const a = new Uint8Array([1, 2]);
      const empty = new Uint8Array([]);
      expect(concatBytes(a, empty)).toEqual(new Uint8Array([1, 2]));
      expect(concatBytes(empty, a)).toEqual(new Uint8Array([1, 2]));
    });

    it("should handle single array", () => {
      const a = new Uint8Array([1, 2, 3]);
      expect(concatBytes(a)).toEqual(a);
    });

    it("should handle no arrays", () => {
      expect(concatBytes()).toEqual(new Uint8Array([]));
    });
  });
});
