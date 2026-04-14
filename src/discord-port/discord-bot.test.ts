import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, Events, ThreadAutoArchiveDuration } from "discord.js";

const {
  canAccessDiscordMessageMock,
  replyToMessageMock,
  buildPromptFromMessageMock,
} = vi.hoisted(() => ({
  canAccessDiscordMessageMock: vi.fn(async () => ({ allowed: true })),
  replyToMessageMock: vi.fn(async () => undefined),
  buildPromptFromMessageMock: vi.fn(
    (message: { content: string }, promptText: string) =>
      promptText || message.content,
  ),
}));

vi.mock("./access-control.js", () => ({
  canAccessDiscordMessage: canAccessDiscordMessageMock,
}));

vi.mock("./message-helpers.js", () => ({
  replyToMessage: replyToMessageMock,
  buildPromptFromMessage: buildPromptFromMessageMock,
}));

import { registerDiscordPortBot } from "./discord-bot.js";

function createClientStub() {
  const handlers = new Map<string | symbol, Array<(...args: any[]) => any>>();
  return {
    on: vi.fn((event: string | symbol, handler: (...args: any[]) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    once: vi.fn((event: string | symbol, handler: (...args: any[]) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    user: { tag: "picord#0001" },
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
    isManagedProjectChannel: vi.fn(
      (channelId: string) => channelId === "project-1",
    ),
    registerLiveRenderer: vi.fn(),
    sealLiveRenderer: vi.fn(async () => undefined),
    clearLiveRenderer: vi.fn(),
    respond: vi.fn(
      async ({ promptText }: { promptText: string }) =>
        `response:${promptText}`,
    ),
    abort: vi.fn(async () => true),
    steer: vi.fn(async () => true),
    waitForRespondDone: vi.fn(async () => undefined),
    isStreaming: vi.fn(() => false),
  };

  return {
    adapter,
    bindThread: vi.fn((thread: any) => ({
      thread,
      workspaceKey: `discord:guild:${thread.guildId}:workspace:${thread.parentId ?? thread.id}`,
      conversationKey: `discord:guild:${thread.guildId}:thread:${thread.id}`,
      sessionName: thread.name,
    })),
  } as any;
}

describe("discord-bot message flow", () => {
  beforeEach(() => {
    canAccessDiscordMessageMock.mockClear();
    replyToMessageMock.mockClear();
    buildPromptFromMessageMock.mockClear();
  });

  it("interrupts the previous thread run and tags the new run with a run id", async () => {
    const client = createClientStub();
    const runtime = createRuntimeStub();

    registerDiscordPortBot({ client, runtime, enableMessageContent: true });

    const thread = {
      id: "thread-1",
      parentId: "project-1",
      guildId: "guild-1",
      name: "session thread",
      type: ChannelType.PublicThread,
      sendTyping: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ edit: vi.fn(async () => undefined) })),
      isThread: () => true,
    };

    const message = {
      author: { bot: false, username: "V", id: "user-1" },
      content: "hello there",
      attachments: { size: 0 },
      inGuild: () => true,
      guildId: "guild-1",
      channelId: "thread-1",
      channel: thread,
      reply: vi.fn(async () => undefined),
    } as any;

    await client.__emit(Events.MessageCreate, message);

    expect(runtime.adapter.registerLiveRenderer).toHaveBeenCalledWith(
      "discord:guild:guild-1:thread:thread-1",
      expect.anything(),
      1,
    );
    expect(runtime.adapter.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "discord:guild:guild-1:thread:thread-1",
        runId: 1,
      }),
    );
  });

  it("interrupts DM runs too instead of letting them pile up", async () => {
    const client = createClientStub();
    const runtime = createRuntimeStub();

    registerDiscordPortBot({ client, runtime, enableMessageContent: true });

    const dmChannel = {
      id: "dm-1",
      type: ChannelType.DM,
      sendTyping: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ edit: vi.fn(async () => undefined) })),
      isThread: () => false,
    };

    const message = {
      author: { bot: false, username: "V", id: "user-1" },
      content: "hi from dm",
      attachments: { size: 0 },
      inGuild: () => false,
      channelId: "dm-1",
      channel: dmChannel,
      reply: vi.fn(async () => undefined),
    } as any;

    await client.__emit(Events.MessageCreate, message);

    expect(runtime.adapter.registerLiveRenderer).toHaveBeenCalledWith(
      "discord:dm:dm-1",
      expect.anything(),
      1,
    );
    expect(runtime.adapter.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "discord:dm:dm-1",
        runId: 1,
      }),
    );
  });

  it("aborts and re-responds when the session is already streaming", async () => {
    const client = createClientStub();
    const runtime = createRuntimeStub();
    runtime.adapter.isStreaming.mockReturnValue(true);

    registerDiscordPortBot({ client, runtime, enableMessageContent: true });

    const thread = {
      id: "thread-1",
      parentId: "project-1",
      guildId: "guild-1",
      name: "session thread",
      type: ChannelType.PublicThread,
      sendTyping: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ edit: vi.fn(async () => undefined) })),
      isThread: () => true,
    };

    const message = {
      author: { bot: false, username: "V", id: "user-1" },
      content: "change direction",
      attachments: { size: 0 },
      inGuild: () => true,
      guildId: "guild-1",
      channelId: "thread-1",
      channel: thread,
      reply: vi.fn(async () => undefined),
    } as any;

    await client.__emit(Events.MessageCreate, message);

    // When streaming: seal → clear → abort → wait for old respond → new respond
    expect(runtime.adapter.sealLiveRenderer).toHaveBeenCalledWith(
      "discord:guild:guild-1:thread:thread-1",
    );
    expect(runtime.adapter.clearLiveRenderer).toHaveBeenCalledWith(
      "discord:guild:guild-1:thread:thread-1",
    );
    expect(runtime.adapter.abort).toHaveBeenCalledWith(
      "discord:guild:guild-1:thread:thread-1",
    );
    expect(runtime.adapter.waitForRespondDone).toHaveBeenCalledWith(
      "discord:guild:guild-1:thread:thread-1",
    );
    expect(runtime.adapter.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "discord:guild:guild-1:thread:thread-1",
        promptText: "change direction",
      }),
    );
  });

  it("aborts and re-responds when the DM session is already streaming", async () => {
    const client = createClientStub();
    const runtime = createRuntimeStub();
    runtime.adapter.isStreaming.mockReturnValue(true);

    registerDiscordPortBot({ client, runtime, enableMessageContent: true });

    const dmChannel = {
      id: "dm-1",
      type: ChannelType.DM,
      sendTyping: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ edit: vi.fn(async () => undefined) })),
      isThread: () => false,
    };

    const message = {
      author: { bot: false, username: "V", id: "user-1" },
      content: "interrupt me",
      attachments: { size: 0 },
      inGuild: () => false,
      channelId: "dm-1",
      channel: dmChannel,
      reply: vi.fn(async () => undefined),
    } as any;

    await client.__emit(Events.MessageCreate, message);

    // When streaming: seal → clear → abort → wait for old respond → new respond
    expect(runtime.adapter.sealLiveRenderer).toHaveBeenCalledWith(
      "discord:dm:dm-1",
    );
    expect(runtime.adapter.clearLiveRenderer).toHaveBeenCalledWith(
      "discord:dm:dm-1",
    );
    expect(runtime.adapter.abort).toHaveBeenCalledWith("discord:dm:dm-1");
    expect(runtime.adapter.waitForRespondDone).toHaveBeenCalledWith(
      "discord:dm:dm-1",
    );
    expect(runtime.adapter.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "discord:dm:dm-1",
        promptText: "interrupt me",
      }),
    );
  });

  it("starts project-channel messages in a new thread with latest-run semantics", async () => {
    const client = createClientStub();
    const runtime = createRuntimeStub();

    registerDiscordPortBot({ client, runtime, enableMessageContent: true });

    const thread = {
      id: "thread-2",
      parentId: "project-1",
      guildId: "guild-1",
      name: "new task",
      type: ChannelType.PublicThread,
      sendTyping: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ edit: vi.fn(async () => undefined) })),
      members: { add: vi.fn(async () => undefined) },
      isThread: () => true,
    };

    const channel = {
      id: "project-1",
      type: ChannelType.GuildText,
      sendTyping: vi.fn(async () => undefined),
      name: "project-1",
      isThread: () => false,
    };

    const message = {
      author: { bot: false, username: "V", id: "user-1" },
      content: "new task",
      attachments: { size: 0 },
      inGuild: () => true,
      guildId: "guild-1",
      channelId: "project-1",
      channel,
      startThread: vi.fn(async (options: any) => {
        expect(options.autoArchiveDuration).toBe(
          ThreadAutoArchiveDuration.OneDay,
        );
        return thread;
      }),
      reply: vi.fn(async () => undefined),
    } as any;

    await client.__emit(Events.MessageCreate, message);

    expect(runtime.adapter.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "discord:guild:guild-1:thread:thread-2",
        runId: 1,
      }),
    );
  });
});
