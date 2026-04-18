/**
 * Unit tests for the bulk-address parser shared by the chat and
 * collab UIs.
 */
import { describe, it, expect } from "vitest";
import { parseBulkAddresses, isValidAddress } from "../../src/collab/address-utils.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";

describe("parseBulkAddresses", () => {
  it("empty / non-string input → all empty arrays", () => {
    const empty = { valid: [], invalid: [], duplicates: [] };
    expect(parseBulkAddresses("")).toEqual(empty);
    expect(parseBulkAddresses("   ")).toEqual(empty);
    expect(parseBulkAddresses(null as any)).toEqual(empty);
  });

  it("single address", () => {
    const r = parseBulkAddresses(A);
    expect(r.valid).toEqual([A.toLowerCase()]);
    expect(r.invalid).toEqual([]);
    expect(r.duplicates).toEqual([]);
  });

  it("comma-separated list", () => {
    const r = parseBulkAddresses(`${A}, ${B}, ${C}`);
    expect(r.valid).toEqual([A, B, C].map((x) => x.toLowerCase()));
  });

  it("newline-separated list (paste from a text file)", () => {
    const r = parseBulkAddresses(`${A}\n${B}\n${C}\n`);
    expect(r.valid).toEqual([A, B, C].map((x) => x.toLowerCase()));
  });

  it("mixed separators (comma + newline + semicolon + whitespace)", () => {
    const r = parseBulkAddresses(`${A} , ${B};\n\t${C}`);
    expect(r.valid).toEqual([A, B, C].map((x) => x.toLowerCase()));
  });

  it("strips wrapping quotes / brackets from JSON-ish copy-paste", () => {
    const r = parseBulkAddresses(`"${A}", '${B}', <${C}>`);
    expect(r.valid).toEqual([A, B, C].map((x) => x.toLowerCase()));
  });

  it("lowercases mixed-case (EIP-55 checksum) addresses", () => {
    const checksum = "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12";
    const r = parseBulkAddresses(checksum);
    expect(r.valid).toEqual([checksum.toLowerCase()]);
  });

  it("flags invalid tokens in `invalid`, keeps going with valid ones", () => {
    const r = parseBulkAddresses(`${A}, not-an-address, ${B}, 0xdeadbeef`);
    expect(r.valid).toEqual([A, B].map((x) => x.toLowerCase()));
    expect(r.invalid).toEqual(["not-an-address", "0xdeadbeef"]);
  });

  it("deduplicates case-insensitively, reports extras in `duplicates`", () => {
    const r = parseBulkAddresses(`${A}, ${A.toUpperCase()}, ${B}, ${A}`);
    expect(r.valid).toEqual([A, B].map((x) => x.toLowerCase()));
    expect(r.duplicates).toHaveLength(2);
  });

  it("too-short hex rejected (20 bytes required)", () => {
    const r = parseBulkAddresses("0x11");
    expect(r.valid).toEqual([]);
    expect(r.invalid).toEqual(["0x11"]);
  });

  it("too-long hex rejected", () => {
    const tooLong = "0x" + "11".repeat(21);
    const r = parseBulkAddresses(tooLong);
    expect(r.valid).toEqual([]);
    expect(r.invalid).toEqual([tooLong]);
  });
});

describe("isValidAddress", () => {
  it("accepts well-formed 42-char addresses, lowercase + mixed", () => {
    expect(isValidAddress(A)).toBe(true);
    expect(isValidAddress("0xAbCd" + "ef".repeat(18))).toBe(true);
  });

  it("rejects empty, short, long, and non-hex", () => {
    expect(isValidAddress("")).toBe(false);
    expect(isValidAddress("0x123")).toBe(false);
    expect(isValidAddress("no-prefix" + "a".repeat(40))).toBe(false);
    expect(isValidAddress("0xzz" + "11".repeat(19))).toBe(false);
  });

  it("trims surrounding whitespace", () => {
    expect(isValidAddress(`   ${A}   `)).toBe(true);
  });
});
