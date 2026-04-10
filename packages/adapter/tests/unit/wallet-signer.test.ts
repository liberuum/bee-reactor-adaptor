import { describe, it, expect } from "vitest";
import { deriveSwarmKey, buildSignMessage } from "../../src/wallet-signer.js";

describe("wallet-signer", () => {
  describe("deriveSwarmKey", () => {
    const TEST_SIG = "0xaabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd1122334400";

    it("should produce a deterministic key", () => {
      const key1 = deriveSwarmKey(TEST_SIG);
      const key2 = deriveSwarmKey(TEST_SIG);
      expect(key1).toBe(key2);
    });

    it("should produce a 32-byte hex key with 0x prefix", () => {
      const key = deriveSwarmKey(TEST_SIG);
      expect(key.startsWith("0x")).toBe(true);
      expect(key.length).toBe(66); // 0x + 64 hex chars
    });

    it("should produce different keys for different signatures", () => {
      const sig2 = "0x1122334455667788112233445566778811223344556677881122334455667788112233445566778811223344556677881122334455667788112233445566778800";
      const key1 = deriveSwarmKey(TEST_SIG);
      const key2 = deriveSwarmKey(sig2);
      expect(key1).not.toBe(key2);
    });
  });

  describe("buildSignMessage", () => {
    it("should include address and origin", () => {
      const msg = buildSignMessage("0xAliceAddress", "https://connect.example.com");
      expect(msg).toContain("Authorize Swarm storage");
      expect(msg).toContain("0xAliceAddress");
      expect(msg).toContain("https://connect.example.com");
    });

    it("should use default origin when not provided", () => {
      const msg = buildSignMessage("0xBobAddress");
      expect(msg).toContain("0xBobAddress");
      expect(msg).toContain("powerhouse-connect");
    });

    it("should include safety disclaimer", () => {
      const msg = buildSignMessage("0xAddr");
      expect(msg).toContain("does not authorize any blockchain transaction");
    });

    it("should be deterministic", () => {
      const msg1 = buildSignMessage("0xAddr", "https://app.com");
      const msg2 = buildSignMessage("0xAddr", "https://app.com");
      expect(msg1).toBe(msg2);
    });
  });
});
