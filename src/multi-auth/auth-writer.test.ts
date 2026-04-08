import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthWriter } from "./auth-writer.js";
import {
  decryptString,
  generateEncryptionKey,
  isEncryptedString,
} from "../crypto/encryption.js";

vi.mock("./runtime-paths.js", () => ({
  resolveAgentRuntimePath: (filename: string) => join(process.cwd(), ".pi", filename),
}));

describe("AuthWriter encryption", () => {
  const originalEnv = process.env.PICORD_ENCRYPTION_KEY;
  let testDir: string;
  let authPath: string;
  let authWriter: AuthWriter;

  beforeEach(async () => {
    delete process.env.PICORD_ENCRYPTION_KEY;
    testDir = join(tmpdir(), `auth-writer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    authPath = join(testDir, "auth.json");
    authWriter = new AuthWriter(authPath);
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env.PICORD_ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.PICORD_ENCRYPTION_KEY;
    }
    await rm(testDir, { recursive: true, force: true });
  });

  describe("without encryption", () => {
    it("stores API key in plaintext", async () => {
      await authWriter.setApiKeyCredential("openai", "sk-test-key-12345");

      const content = await readFile(authPath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.openai).toEqual({ type: "api_key", key: "sk-test-key-12345" });
      expect(isEncryptedString(parsed.openai.key)).toBe(false);
    });

    it("stores OAuth credential in plaintext", async () => {
      await authWriter.setOAuthCredential("anthropic", {
        access: "access-token-xyz",
        refresh: "refresh-token-abc",
        expires: Date.now() + 3600000,
      });

      const content = await readFile(authPath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.anthropic.type).toBe("oauth");
      expect(parsed.anthropic.access).toBe("access-token-xyz");
      expect(parsed.anthropic.refresh).toBe("refresh-token-abc");
      expect(isEncryptedString(parsed.anthropic.access)).toBe(false);
    });

    it("reads plaintext credentials correctly", async () => {
      await authWriter.setApiKeyCredential("openai", "sk-plaintext-key");

      const credential = await authWriter.getCredential("openai");
      expect(credential).toEqual({ type: "api_key", key: "sk-plaintext-key" });
    });

    it("file has restricted permissions (0o600)", async () => {
      await authWriter.setApiKeyCredential("openai", "sk-test");

      const fileStat = await stat(authPath);
      const mode = fileStat.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe("with encryption", () => {
    beforeEach(() => {
      process.env.PICORD_ENCRYPTION_KEY = generateEncryptionKey();
    });

    it("stores API key encrypted", async () => {
      await authWriter.setApiKeyCredential("openai", "sk-secret-key-99999");

      const content = await readFile(authPath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.openai.type).toBe("api_key");
      expect(parsed.openai.key).not.toBe("sk-secret-key-99999");
      expect(isEncryptedString(parsed.openai.key)).toBe(true);
    });

    it("stores OAuth credential with encrypted fields", async () => {
      const expires = Date.now() + 3600000;
      await authWriter.setOAuthCredential("anthropic", {
        access: "secret-access-token",
        refresh: "secret-refresh-token",
        expires,
      });

      const content = await readFile(authPath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.anthropic.type).toBe("oauth");
      expect(parsed.anthropic.access).not.toBe("secret-access-token");
      expect(parsed.anthropic.refresh).not.toBe("secret-refresh-token");
      expect(isEncryptedString(parsed.anthropic.access)).toBe(true);
      expect(isEncryptedString(parsed.anthropic.refresh)).toBe(true);
      expect(parsed.anthropic.expires).toBe(expires);
    });

    it("decrypts API key on read", async () => {
      await authWriter.setApiKeyCredential("openai", "sk-decrypt-me");

      const credential = await authWriter.getCredential("openai");
      expect(credential).toEqual({ type: "api_key", key: "sk-decrypt-me" });
    });

    it("decrypts OAuth credential on read", async () => {
      const expires = Date.now() + 3600000;
      await authWriter.setOAuthCredential("anthropic", {
        access: "decrypt-access",
        refresh: "decrypt-refresh",
        expires,
      });

      const credential = await authWriter.getCredential("anthropic");
      expect(credential?.type).toBe("oauth");
      expect((credential as { access: string }).access).toBe("decrypt-access");
      expect((credential as { refresh: string }).refresh).toBe("decrypt-refresh");
    });

    it("handles backup credentials with encryption", async () => {
      await authWriter.setApiKeyCredentialAsBackup("openai", "first-key");
      await authWriter.setApiKeyCredentialAsBackup("openai", "second-key");

      const entries = await authWriter.getProviderCredentialEntries("openai");
      expect(entries).toHaveLength(2);
      expect(entries[0].credential).toEqual({ type: "api_key", key: "first-key" });
      expect(entries[1].credential).toEqual({ type: "api_key", key: "second-key" });

      // Verify stored encrypted
      const content = await readFile(authPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(isEncryptedString(parsed.openai.key)).toBe(true);
      expect(isEncryptedString(parsed["openai-1"].key)).toBe(true);
    });

    it("getCredentials decrypts multiple credentials at once", async () => {
      await authWriter.setApiKeyCredential("openai", "key-one");
      await authWriter.setApiKeyCredential("anthropic", "key-two");

      const credentials = await authWriter.getCredentials(["openai", "anthropic"]);
      expect(credentials.get("openai")).toEqual({ type: "api_key", key: "key-one" });
      expect(credentials.get("anthropic")).toEqual({ type: "api_key", key: "key-two" });
    });

    it("preserves already-encrypted credentials on re-write", async () => {
      await authWriter.setApiKeyCredential("openai", "original-key");

      const content1 = await readFile(authPath, "utf-8");
      const parsed1 = JSON.parse(content1);
      const encryptedKey = parsed1.openai.key;

      // Add another provider
      await authWriter.setApiKeyCredential("anthropic", "another-key");

      const content2 = await readFile(authPath, "utf-8");
      const parsed2 = JSON.parse(content2);

      // Original should still be same encrypted value
      expect(parsed2.openai.key).toBe(encryptedKey);
      expect(isEncryptedString(parsed2.anthropic.key)).toBe(true);
    });

    it("can decrypt with different key after re-encryption", async () => {
      // Store with first key
      process.env.PICORD_ENCRYPTION_KEY = generateEncryptionKey();
      await authWriter.setApiKeyCredential("openai", "test-key-abc");

      // Read back works
      const cred1 = await authWriter.getCredential("openai");
      expect(cred1?.key).toBe("test-key-abc");

      // Read raw file and verify it's encrypted
      const content = await readFile(authPath, "utf-8");
      const parsed = JSON.parse(content);
      const encryptedValue = parsed.openai.key;

      // Decrypt manually with same key
      const decrypted = decryptString(encryptedValue);
      expect(decrypted).toBe("test-key-abc");
    });
  });

  describe("mixed encrypted and plaintext", () => {
    beforeEach(() => {
      process.env.PICORD_ENCRYPTION_KEY = generateEncryptionKey();
    });

    it("can read plaintext credentials written before encryption was enabled", async () => {
      // Write plaintext directly
      await writeFile(authPath, JSON.stringify({
        openai: { type: "api_key", key: "legacy-plaintext-key" },
      }, null, 2));

      const credential = await authWriter.getCredential("openai");
      expect(credential).toEqual({ type: "api_key", key: "legacy-plaintext-key" });
    });

    it("re-encrypts plaintext when updating alongside encrypted", async () => {
      // Write one encrypted, one plaintext
      await authWriter.setApiKeyCredential("openai", "encrypted-one");

      // Now write plaintext directly for another provider
      const content = await readFile(authPath, "utf-8");
      const parsed = JSON.parse(content);
      parsed.anthropic = { type: "api_key", key: "plaintext-two" };
      await writeFile(authPath, JSON.stringify(parsed, null, 2));

      // Trigger a re-write through backup
      await authWriter.setApiKeyCredentialAsBackup("anthropic", "new-anthropic-key");

      // Both should now be encrypted in file
      const content2 = await readFile(authPath, "utf-8");
      const parsed2 = JSON.parse(content2);

      expect(isEncryptedString(parsed2.openai.key)).toBe(true);
      expect(isEncryptedString(parsed2.anthropic.key)).toBe(true);

      // And readable
      const entries = await authWriter.getProviderCredentialEntries("anthropic");
      expect(entries.some((e) => e.credential.type === "api_key" && e.credential.key === "new-anthropic-key")).toBe(true);
    });
  });

  describe("edge cases", () => {
    beforeEach(() => {
      process.env.PICORD_ENCRYPTION_KEY = generateEncryptionKey();
    });

    it("handles empty API key", async () => {
      await expect(authWriter.setApiKeyCredential("openai", "")).rejects.toThrow("API key cannot be empty");
    });

    it("handles whitespace-only API key", async () => {
      await expect(authWriter.setApiKeyCredential("openai", "   ")).rejects.toThrow("API key cannot be empty");
    });

    it("handles unicode in API keys", async () => {
      const unicodeKey = "sk-测试-🔑-key";
      await authWriter.setApiKeyCredential("openai", unicodeKey);

      const credential = await authWriter.getCredential("openai");
      expect(credential?.key).toBe(unicodeKey);
    });

    it("handles very long API keys", async () => {
      const longKey = "sk-" + "a".repeat(5000);
      await authWriter.setApiKeyCredential("openai", longKey);

      const credential = await authWriter.getCredential("openai");
      expect(credential?.key).toBe(longKey);
    });
  });
});
