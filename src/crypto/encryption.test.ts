import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encryptString,
  decryptString,
  isEncryptedString,
  isEncryptionAvailable,
  generateEncryptionKey,
} from "./encryption.js";

describe("encryption", () => {
  const originalEnv = process.env.PICORD_ENCRYPTION_KEY;

  beforeEach(() => {
    delete process.env.PICORD_ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PICORD_ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.PICORD_ENCRYPTION_KEY;
    }
  });

  describe("without PICORD_ENCRYPTION_KEY", () => {
    it("isEncryptionAvailable returns false", () => {
      expect(isEncryptionAvailable()).toBe(false);
    });

    it("encryptString returns null", () => {
      expect(encryptString("test")).toBeNull();
    });

    it("decryptString returns null", () => {
      expect(decryptString("test")).toBeNull();
    });
  });

  describe("with PICORD_ENCRYPTION_KEY", () => {
    beforeEach(() => {
      process.env.PICORD_ENCRYPTION_KEY = generateEncryptionKey();
    });

    it("isEncryptionAvailable returns true", () => {
      expect(isEncryptionAvailable()).toBe(true);
    });

    it("encrypts and decrypts a string", () => {
      const plaintext = "sk-proj-test-api-key-12345";
      const encrypted = encryptString(plaintext);
      expect(encrypted).not.toBeNull();
      expect(encrypted).not.toBe(plaintext);

      const decrypted = decryptString(encrypted!);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertext for same plaintext (random IV)", () => {
      const plaintext = "test-key";
      const encrypted1 = encryptString(plaintext);
      const encrypted2 = encryptString(plaintext);
      expect(encrypted1).not.toBe(encrypted2);
      expect(decryptString(encrypted1!)).toBe(plaintext);
      expect(decryptString(encrypted2!)).toBe(plaintext);
    });

    it("isEncryptedString detects encrypted format", () => {
      const plaintext = "test-key";
      const encrypted = encryptString(plaintext);
      expect(isEncryptedString(encrypted!)).toBe(true);
      expect(isEncryptedString(plaintext)).toBe(false);
    });

    it("decryptString returns null for invalid format", () => {
      expect(decryptString("not-encrypted")).toBeNull();
      expect(decryptString("not:valid:base64")).toBeNull();
    });

    it("handles empty string", () => {
      const encrypted = encryptString("");
      expect(encrypted).not.toBeNull();
      expect(decryptString(encrypted!)).toBe("");
    });

    it("handles unicode characters", () => {
      const plaintext = "你好世界 🌍";
      const encrypted = encryptString(plaintext);
      expect(decryptString(encrypted!)).toBe(plaintext);
    });

    it("handles long strings", () => {
      const plaintext = "a".repeat(10000);
      const encrypted = encryptString(plaintext);
      expect(decryptString(encrypted!)).toBe(plaintext);
    });
  });

  describe("generateEncryptionKey", () => {
    it("generates a base64 key", () => {
      const key = generateEncryptionKey();
      expect(key).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it("generates unique keys", () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      expect(key1).not.toBe(key2);
    });
  });
});
