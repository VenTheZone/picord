import { describe, expect, it, vi } from "vitest";
import { Events } from "discord.js";
import { registerDiscordPortInteractionHandler } from "./interaction-handler.js";

function createClientStub() {
  const handlers = new Map<string | symbol, Array<(...args: any[]) => any>>();
  return {
    on: vi.fn((event: string | symbol, handler: (...args: any[]) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    __emit: async (event: string | symbol, ...args: any[]) => {
      for (const handler of handlers.get(event) ?? []) {
        await handler(...args);
      }
    },
  } as any;
}

function createRuntimeStub() {
  const adapter = {
    config: { hostChannelName: "host" },
    isOwner: vi.fn(() => true),
    listLoginProviders: vi.fn(() => [
      {
        id: "github-copilot",
        name: "GitHub Copilot",
        method: "oauth",
        hasStoredAuth: false,
        supportsDiscordFlow: true,
      },
      {
        id: "openrouter",
        name: "OpenRouter",
        method: "api-key",
        hasStoredAuth: false,
        supportsDiscordFlow: true,
      },
    ]),
    startProviderOAuthLogin: vi.fn(async (providerId: string) => ({
      url: "https://example.com/verify",
      instructions: "Open page then enter code: ABCD-EFGH",
      pendingPrompt: providerId === "github-copilot"
        ? { message: "GitHub Enterprise URL/domain (blank for github.com)", placeholder: "company.ghe.com", allowEmpty: true }
        : undefined,
    })),
    getPendingOAuthPrompt: vi.fn(() => ({
      message: "GitHub Enterprise URL/domain (blank for github.com)",
      placeholder: "company.ghe.com",
      allowEmpty: true,
    })),
    submitProviderOAuthPrompt: vi.fn(),
    completeProviderOAuthLogin: vi.fn(async () => undefined),
    setProviderApiKey: vi.fn(),
  };

  return {
    adapter,
    listAvailableProjects: vi.fn(() => []),
    getProjectsDir: vi.fn(() => "/projects"),
  } as any;
}

function createHostSelectInteraction(providerId: string) {
  return {
    commandName: "login",
    customId: "login:provider",
    values: [providerId],
    guildId: "guild-1",
    channelId: "host-1",
    channel: { isThread: () => false, name: "host" },
    user: { id: "user-1" },
    memberPermissions: { has: () => true },
    deferred: false,
    replied: false,
    inGuild: () => true,
    isAutocomplete: () => false,
    isStringSelectMenu: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    update: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as any;
}

function createOAuthPromptButtonInteraction(providerId: string) {
  return {
    customId: `login:oauth:prompt:${providerId}`,
    guildId: "guild-1",
    channelId: "host-1",
    channel: { isThread: () => false, name: "host" },
    user: { id: "user-1" },
    memberPermissions: { has: () => true },
    deferred: false,
    replied: false,
    inGuild: () => true,
    isAutocomplete: () => false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    showModal: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as any;
}

function createOAuthButtonInteraction(providerId: string) {
  return {
    customId: `login:oauth:complete:${providerId}`,
    guildId: "guild-1",
    channelId: "host-1",
    channel: { isThread: () => false, name: "host" },
    user: { id: "user-1" },
    memberPermissions: { has: () => true },
    deferred: false,
    replied: false,
    inGuild: () => true,
    isAutocomplete: () => false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    showModal: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as any;
}

function createOAuthPromptModalInteraction(providerId: string) {
  return {
    customId: `login:oauth:modal:${providerId}:prompt`,
    guildId: "guild-1",
    channelId: "host-1",
    channel: { isThread: () => false, name: "host" },
    user: { id: "user-1" },
    memberPermissions: { has: () => true },
    deferred: false,
    replied: false,
    inGuild: () => true,
    isAutocomplete: () => false,
    isStringSelectMenu: () => false,
    isButton: () => false,
    isModalSubmit: () => true,
    isChatInputCommand: () => false,
    fields: { getTextInputValue: vi.fn(() => "") },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as any;
}

function createOAuthModalInteraction(providerId: string) {
  return {
    customId: `login:oauth:modal:${providerId}`,
    guildId: "guild-1",
    channelId: "host-1",
    channel: { isThread: () => false, name: "host" },
    user: { id: "user-1" },
    memberPermissions: { has: () => true },
    deferred: false,
    replied: false,
    inGuild: () => true,
    isAutocomplete: () => false,
    isStringSelectMenu: () => false,
    isButton: () => false,
    isModalSubmit: () => true,
    isChatInputCommand: () => false,
    fields: { getTextInputValue: vi.fn(() => "http://localhost:1455/auth/callback?code=abc&state=123") },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as any;
}

describe("interaction OAuth flow", () => {
  it("starts a generic OAuth login from the provider selector", async () => {
    const client = createClientStub();
    const runtime = createRuntimeStub();
    registerDiscordPortInteractionHandler({ client, runtime });

    const interaction = createHostSelectInteraction("github-copilot");
    await client.__emit(Events.InteractionCreate, interaction);

    expect(runtime.adapter.startProviderOAuthLogin).toHaveBeenCalledWith("github-copilot", "user-1");
    expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("GitHub Copilot login ready"),
      embeds: [expect.objectContaining({ data: expect.objectContaining({ title: "GitHub Copilot Login" }) })],
    }));
    const payload = interaction.update.mock.calls[0]?.[0];
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("login:oauth:prompt:github-copilot");
  });

  it("opens a provider prompt modal and submits the prompt answer", async () => {
    const client = createClientStub();
    const runtime = createRuntimeStub();
    registerDiscordPortInteractionHandler({ client, runtime });

    const button = createOAuthPromptButtonInteraction("github-copilot");
    await client.__emit(Events.InteractionCreate, button);
    expect(button.showModal).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        custom_id: "login:oauth:modal:github-copilot:prompt",
        title: "Answer GitHub Copilot prompt",
      }),
    }));

    const modal = createOAuthPromptModalInteraction("github-copilot");
    await client.__emit(Events.InteractionCreate, modal);
    expect(runtime.adapter.submitProviderOAuthPrompt).toHaveBeenCalledWith("github-copilot", "user-1", "");
    expect(modal.editReply).toHaveBeenCalledWith({ content: "GitHub Copilot prompt answer submitted. Finish the browser/device step, then use Complete login." });
  });

  it("opens a provider-scoped completion modal and completes the generic OAuth flow", async () => {
    const client = createClientStub();
    const runtime = createRuntimeStub();
    registerDiscordPortInteractionHandler({ client, runtime });

    const button = createOAuthButtonInteraction("github-copilot");
    await client.__emit(Events.InteractionCreate, button);
    expect(button.showModal).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        custom_id: "login:oauth:modal:github-copilot",
        title: "Complete GitHub Copilot login",
      }),
    }));

    const modal = createOAuthModalInteraction("github-copilot");
    await client.__emit(Events.InteractionCreate, modal);
    expect(runtime.adapter.completeProviderOAuthLogin).toHaveBeenCalledWith(
      "github-copilot",
      "user-1",
      "http://localhost:1455/auth/callback?code=abc&state=123",
    );
    expect(modal.editReply).toHaveBeenCalledWith({ content: "GitHub Copilot login completed successfully." });
  });
});
