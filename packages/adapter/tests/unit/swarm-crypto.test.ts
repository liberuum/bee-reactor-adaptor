import { describe, it, expect } from "vitest";
import { encrypt, decrypt, isEncrypted, encryptJSON, decryptJSON } from "../../src/swarm-crypto.js";

const TEST_KEY = "0xaabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344";
const WRONG_KEY = "0x1122334455667788112233445566778811223344556677881122334455667788";

describe("swarm-crypto", () => {
  describe("encrypt / decrypt", () => {
    it("should roundtrip a string", async () => {
      const plaintext = "Hello Swarm! This is private data.";
      const encrypted = await encrypt(plaintext, TEST_KEY);
      const decrypted = await decrypt(encrypted, TEST_KEY);
      expect(new TextDecoder().decode(decrypted)).toBe(plaintext);
    });

    it("should roundtrip a Uint8Array", async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
      const encrypted = await encrypt(data, TEST_KEY);
      const decrypted = await decrypt(encrypted, TEST_KEY);
      expect(decrypted).toEqual(data);
    });

    it("should produce different ciphertext for same plaintext (random IV)", async () => {
      const enc1 = await encrypt("same data", TEST_KEY);
      const enc2 = await encrypt("same data", TEST_KEY);
      expect(enc1).not.toEqual(enc2);
    });

    it("should fail to decrypt with wrong key", async () => {
      const encrypted = await encrypt("secret data", TEST_KEY);
      await expect(decrypt(encrypted, WRONG_KEY)).rejects.toThrow();
    });

    it("should fail to decrypt non-encrypted data", async () => {
      const plain = new Uint8Array([0, 0, 0, 1, 2, 3]);
      await expect(decrypt(plain, TEST_KEY)).rejects.toThrow("missing SWE prefix");
    });

    it("should handle empty string", async () => {
      const encrypted = await encrypt("", TEST_KEY);
      const decrypted = await decrypt(encrypted, TEST_KEY);
      expect(new TextDecoder().decode(decrypted)).toBe("");
    });

    it("should handle large data", async () => {
      const large = "x".repeat(100_000);
      const encrypted = await encrypt(large, TEST_KEY);
      const decrypted = await decrypt(encrypted, TEST_KEY);
      expect(new TextDecoder().decode(decrypted)).toBe(large);
    });
  });

  describe("isEncrypted", () => {
    it("should detect SWE prefix on encrypted data", async () => {
      const encrypted = await encrypt("test", TEST_KEY);
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it("should return false for plain text", () => {
      const plain = new TextEncoder().encode("plain text");
      expect(isEncrypted(plain)).toBe(false);
    });

    it("should return false for data too short", () => {
      expect(isEncrypted(new Uint8Array([0x53, 0x57]))).toBe(false);
    });

    it("should return false for empty data", () => {
      expect(isEncrypted(new Uint8Array([]))).toBe(false);
    });

    it("should detect SWE prefix bytes (0x53, 0x57, 0x45)", async () => {
      const encrypted = await encrypt("x", TEST_KEY);
      expect(encrypted[0]).toBe(0x53); // 'S'
      expect(encrypted[1]).toBe(0x57); // 'W'
      expect(encrypted[2]).toBe(0x45); // 'E'
    });
  });

  describe("encryptJSON / decryptJSON", () => {
    it("should roundtrip a JSON object", async () => {
      const obj = { operations: [{ type: "SET_TITLE", input: { title: "Test" } }], count: 42 };
      const encrypted = await encryptJSON(obj, TEST_KEY);
      const decrypted = await decryptJSON(encrypted, TEST_KEY);
      expect(decrypted).toEqual(obj);
    });

    it("should roundtrip arrays", async () => {
      const arr = [1, "two", { three: true }];
      const encrypted = await encryptJSON(arr, TEST_KEY);
      const decrypted = await decryptJSON(encrypted, TEST_KEY);
      expect(decrypted).toEqual(arr);
    });

    it("should roundtrip null", async () => {
      const encrypted = await encryptJSON(null, TEST_KEY);
      const decrypted = await decryptJSON(encrypted, TEST_KEY);
      expect(decrypted).toBeNull();
    });
  });
});
