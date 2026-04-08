import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthWriter } from "../auth-writer.js";
import { KeyDistributor } from "./key-distributor.js";
import { MultiAuthStorage } from "../storage.js";
import { generateEncryptionKey } from "../../crypto/encryption.js";
import type { MultiAuthState, ProviderRotationState } from "../types.js";

vi.mock("../runtime-paths.js", () => ({
  resolveAgentRuntimePath: (filename: string) => join(process.cwd(), ".pi", filename),
}));

function createProviderState(credentialIds: string[]): ProviderRotationState {
  return {
    credentialIds,
    activeIndex: 0,
    rotationMode: "round-robin",
    lastUsedAt: {},
    usageCount: {},
    quotaErrorCount: {},
    quotaExhaustedUntil: {},
    lastQuotaError: {},
    lastTransientError: {},
    transientErrorCount: {},
    weeklyQuotaAttempts: {},
    friendlyNames: {},
    disabledCredentials: {},
  };
}

function createEmptyState(): MultiAuthState {
  return {
    version: 1,
    providers: {},
    ui: {
      hiddenProviders: [],
    },
  };
}

describe("KeyDistributor encryption integration", () => {
  const originalEnv = process.env.PICORD_ENCRYPTION_KEY;
  let testDir: string;
  let authPath: string;
  let storagePath: string;
  let authWriter: AuthWriter;
  let storage: MultiAuthStorage;
  let keyDistributor: KeyDistributor;

  beforeEach(async () => {
    delete process.env.PICORD_ENCRYPTION_KEY;
    testDir = join(tmpdir(), `key-distributor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    authPath = join(testDir, "auth.json");
    storagePath = join(testDir, "multi-auth-state.json");
    authWriter = new AuthWriter(authPath);
    storage = new MultiAuthStorage(storagePath);
    keyDistributor = new KeyDistributor(storage, authWriter);
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env.PICORD_ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.PICORD_ENCRYPTION_KEY;
    }
    await rm(testDir, { recursive: true, force: true });
  });

  async function setupProvider(providerId: string, credentialIds: string[]): Promise<void> {
    await storage.withLock(async (state) => {
      const next: MultiAuthState = {
        ...createEmptyState(),
        ...state,
        providers: {
          ...state.providers,
          [providerId]: createProviderState(credentialIds),
        },
      };
      return { result: undefined, next };
    });
  }

  describe("without encryption", () => {
    it("resolves plaintext API key from storage", async () => {
      // Store plaintext credential
      await authWriter.setApiKeyCredential("openai", "sk-plaintext-test-key");
      await setupProvider("openai", ["openai"]);

      // Acquire lease
      const lease = await keyDistributor.acquireForSubagent("session-1", "openai");
      expect(lease.credentialId).toBe("openai");
      expect(lease.apiKey).toBe("sk-plaintext-test-key");
    });
  });

  describe("with encryption", () => {
    beforeEach(() => {
      process.env.PICORD_ENCRYPTION_KEY = generateEncryptionKey();
    });

    it("decrypts stored API key for distribution", async () => {
      // Store encrypted credential
      await authWriter.setApiKeyCredential("openai", "sk-encrypted-secret-key");
      await setupProvider("openai", ["openai"]);

      // Acquire lease - should receive decrypted key
      const lease = await keyDistributor.acquireForSubagent("session-1", "openai");
      expect(lease.credentialId).toBe("openai");
      expect(lease.apiKey).toBe("sk-encrypted-secret-key");
    });

    it("handles multiple encrypted credentials", async () => {
      // Store multiple encrypted credentials
      await authWriter.setApiKeyCredential("openai", "key-one");
      await authWriter.setApiKeyCredential("openai-2", "key-two");
      await setupProvider("openai", ["openai", "openai-2"]);

      // First session gets first key
      const lease1 = await keyDistributor.acquireForSubagent("session-1", "openai");
      expect(["key-one", "key-two"]).toContain(lease1.apiKey);

      // Second session gets different key
      const lease2 = await keyDistributor.acquireForSubagent("session-2", "openai");
      expect(["key-one", "key-two"]).toContain(lease2.apiKey);
    });

    it("releases and reacquires encrypted credential", async () => {
      await authWriter.setApiKeyCredential("anthropic", "sk-ant-test");
      await setupProvider("anthropic", ["anthropic"]);

      // Acquire
      const lease = await keyDistributor.acquireForSubagent("session-1", "anthropic");
      expect(lease.apiKey).toBe("sk-ant-test");

      // Release
      keyDistributor.releaseFromSubagent("session-1");

      // Re-acquire same session
      const lease2 = await keyDistributor.acquireForSubagent("session-1", "anthropic");
      expect(lease2.apiKey).toBe("sk-ant-test");
    });

    it("acquireKey returns credential ID for orchestrator", async () => {
      await authWriter.setApiKeyCredential("openai", "orchestrator-key");
      await setupProvider("openai", ["openai"]);

      const credentialId = await keyDistributor.acquireKey({
        providerId: "openai",
        excludedIds: [],
        requestingSessionId: "orchestrator-session",
      });
      expect(credentialId).toBe("openai");

      // Verify the credential can be resolved
      const credential = await authWriter.getCredential(credentialId);
      expect(credential?.key).toBe("orchestrator-key");
    });
  });

  describe("credential rotation with encryption", () => {
    beforeEach(() => {
      process.env.PICORD_ENCRYPTION_KEY = generateEncryptionKey();
    });

    it("maintains encryption through credential refresh", async () => {
      await authWriter.setApiKeyCredential("openai", "original-key");
      await setupProvider("openai", ["openai"]);

      // Acquire lease
      const lease1 = await keyDistributor.acquireForSubagent("session-1", "openai");
      expect(lease1.apiKey).toBe("original-key");

      // Release
      keyDistributor.releaseFromSubagent("session-1");

      // Verify credential is still decrypted correctly
      const storedCred = await authWriter.getCredential("openai");
      expect(storedCred?.key).toBe("original-key");
    });
  });
});
