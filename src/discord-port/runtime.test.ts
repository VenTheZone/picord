import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordPortRuntime } from "./runtime.js";
import type { DiscordPortRuntimeAdapter } from "./types.js";
import type { ThinkingLevel } from "../types.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "picord-runtime-test-"));
  tempDirs.push(dir);
  return dir;
}

function createAdapter(overrides: Partial<DiscordPortRuntimeAdapter> = {}): DiscordPortRuntimeAdapter {
  const thinkingLevel: ThinkingLevel = "medium";

  return {
    config: {
      allowDm: true,
      cwd: process.cwd(),
      statePath: path.join(process.cwd(), "picord.state.json"),
      workspaceBasePath: process.cwd(),
      workspaceRoots: {},
      toolMode: "coding",
      allowedGuildIds: [],
      allowedChannelIds: [],
      allowedRoleIds: [],
      allowedRoleNames: [],
      allowedUserIds: [],
      blockedPathPatterns: [],
      hostChannelName: "host",
      registerCommands: true,
      thinkingLevel,
      critiqueAutoShare: false,
      systemPromptAppend: "",
      isActive: true,
      ...overrides.config,
    },
    isOwner: () => true,
    listManagedProjects: () => [],
    isManagedProjectChannel: () => false,
    addManagedProject: async (channelId, root, name) => ({ channelId, root, name }),
    hasBoundSession: () => false,
    getBoundSessionSummary: () => undefined,
    getSessionCount: () => 0,
    getSkillSummaries: () => [],
    getWorkspaceModelScope: () => ({ patterns: [], models: [] }),
    getAvailableModels: () => [],
    getWorkspaceInfo: () => ({ root: process.cwd() }),
    getBlockedPathPatterns: () => [],
    listSessionsForWorkspace: async () => [],
    listAllSessions: async () => [],
    setWorkspaceModelScope: () => ({ patterns: [], models: [] }),
    clearWorkspaceModelScope: () => ({ patterns: [], models: [] }),
    setWorkspaceModel: async () => ({ provider: "openai", id: "gpt-5.4" }),
    setConversationModel: async () => ({ provider: "openai", id: "gpt-5.4" }),
    getEffectiveModel: () => undefined,
    setWorkspaceThinkingLevel: () => undefined,
    setConversationThinkingLevel: () => undefined,
    getEffectiveThinkingLevel: () => thinkingLevel,
    listLoginProviders: () => [],
    setProviderApiKey: () => undefined,
    startOpenAICodexLogin: async () => ({ url: "https://example.com" }),
    completeOpenAICodexLogin: async () => undefined,
    respond: async () => "Done.",
    invokeSkill: async () => "Done.",
    listSkillSummaries: () => [],
    getPendingAccessRequests: () => [],
    resolveAccessRequest: () => undefined,
    abort: async () => false,
    reset: async () => false,
    resumeSession: async () => ({ id: "session-1", cwd: process.cwd() }),
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("DiscordPortRuntime", () => {
  it("lists available projects and marks managed directories", () => {
    const baseDir = createTempDir();
    mkdirSync(path.join(baseDir, "alpha"));
    mkdirSync(path.join(baseDir, "beta"));

    const runtime = new DiscordPortRuntime(
      {} as never,
      createAdapter({
        config: {
          allowDm: true,
          cwd: process.cwd(),
          statePath: path.join(process.cwd(), "picord.state.json"),
          workspaceBasePath: baseDir,
          workspaceRoots: {},
          toolMode: "coding",
          allowedGuildIds: [],
          allowedChannelIds: [],
          allowedRoleIds: [],
          allowedRoleNames: [],
          allowedUserIds: [],
          blockedPathPatterns: [],
          hostChannelName: "host",
          registerCommands: true,
          thinkingLevel: "medium",
          critiqueAutoShare: false,
          systemPromptAppend: "",
          isActive: true,
        },
        listManagedProjects: () => [{ channelId: "123", root: path.join(baseDir, "beta"), name: "beta" }],
      }),
    );

    expect(runtime.listAvailableProjects()).toEqual([
      { name: "alpha", root: path.join(baseDir, "alpha"), managed: false, channelId: undefined },
      { name: "beta", root: path.join(baseDir, "beta"), managed: true, channelId: "123" },
    ]);
  });

  it("includes active model and thinking level in status output", () => {
    const runtime = new DiscordPortRuntime(
      {} as never,
      createAdapter({
        getWorkspaceInfo: () => ({ root: "/workspace/demo" }),
        getEffectiveModel: () => ({ provider: "openai-codex", id: "gpt-5.4" }),
        getEffectiveThinkingLevel: () => "high",
        isManagedProjectChannel: () => true,
      }),
    );

    const status = runtime.buildProjectChannelStatus({ guildId: "guild-1", channelId: "channel-1" });

    expect(status).toContain("activeModel: openai-codex/gpt-5.4");
    expect(status).toContain("activeThinkingLevel: high");
    expect(status).toContain("workspaceRoot: /workspace/demo");
  });
});
