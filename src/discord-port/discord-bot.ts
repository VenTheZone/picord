import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ThreadAutoArchiveDuration,
  type Message,
  type TextChannel,
} from "discord.js";
import { canAccessDiscordMessage } from "./access-control.js";
import { buildPromptFromMessage, replyToMessage, sendTextResponse } from "./message-helpers.js";
import { registerDiscordPortInteractionHandler } from "./interaction-handler.js";
import { DiscordPortRuntime } from "./runtime.js";
import type { DiscordPortRuntimeAdapter } from "./types.js";

function isThreadChannel(channel: Message["channel"]): boolean {
  return channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread;
}

function isProjectTextChannel(channel: Message["channel"], runtime: DiscordPortRuntime): channel is TextChannel {
  return channel.type === ChannelType.GuildText && runtime.adapter.isManagedProjectChannel(channel.id);
}

function buildAutoThreadName(message: Message): string {
  const normalized = message.content
    .replace(/<@!?(\d+)>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || "picord session").slice(0, 80);
}

function isHostControlChannel(message: Message, runtime: DiscordPortRuntime): boolean {
  if (!message.inGuild()) {
    return false;
  }

  if (runtime.adapter.config.hostChannelId) {
    return message.channelId === runtime.adapter.config.hostChannelId;
  }

  return message.channel.type === ChannelType.GuildText
    && message.channel.name.toLowerCase() === runtime.adapter.config.hostChannelName;
}

export function createDiscordPortClient(enableMessageContent: boolean = true): Client {
  return new Client({
    intents: enableMessageContent
      ? [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ]
      : [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
        ],
    partials: [Partials.Channel],
  });
}

export function registerDiscordPortBot({
  client,
  runtime,
  enableMessageContent = true,
  onReload,
  onInfo,
  onWarning,
  onError,
}: {
  client: Client;
  runtime: DiscordPortRuntime;
  enableMessageContent?: boolean;
  onReload?: () => void;
  onInfo?: (message: string) => void;
  onWarning?: (message: string) => void;
  onError?: (message: string) => void;
}) {
  registerDiscordPortInteractionHandler({ client, runtime, onReload });

  if (enableMessageContent) {
    client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author.bot) {
        return;
      }

      const promptText = message.content.trim();
      if (!promptText && message.attachments.size === 0) {
        return;
      }

      const access = await canAccessDiscordMessage(runtime.adapter.config, runtime.adapter, message);
      if (!access.allowed) {
        await replyToMessage(message, access.reason ?? "You are not allowed to use this bot here.");
        return;
      }

      if (!message.inGuild()) {
        if ("sendTyping" in message.channel) {
          await message.channel.sendTyping().catch(() => undefined);
        }

        const dmResponse = await runtime.adapter.respond({
          conversationKey: `discord:dm:${message.channelId}`,
          workspaceKey: `discord:dm:${message.channelId}`,
          sessionName: `dm-${message.author.username}`,
          promptText: buildPromptFromMessage(message, promptText),
        });
        await replyToMessage(message, dmResponse);
        return;
      }

      if (isHostControlChannel(message, runtime)) {
        return;
      }

      if (isThreadChannel(message.channel)) {
        if ("sendTyping" in message.channel) {
          await message.channel.sendTyping().catch(() => undefined);
        }

        const thread = message.channel as Parameters<typeof runtime.continueThread>[0]["thread"];
        const response = await runtime.continueThread({
          thread,
          message,
        });
        await replyToMessage(message, response);
        return;
      }

      if (!isProjectTextChannel(message.channel, runtime)) {
        return;
      }

      const thread = await message.startThread({
        name: buildAutoThreadName(message),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        reason: "picord auto-started session thread",
      });
      await thread.members.add(message.author.id).catch(() => undefined);

      await thread.sendTyping().catch(() => undefined);

      const response = await runtime.continueThread({
        thread,
        message,
      });
      await sendTextResponse(thread, response);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      onError?.(`discord-port message flow error: ${text}`);
      await replyToMessage(message, `picord error: ${text}`).catch(() => undefined);
    }
    });
  }

  client.once(Events.ClientReady, () => {
    onInfo?.(`discord-port connected as ${client.user?.tag ?? "Discord bot"}`);
  });

  client.on(Events.Error, (error) => {
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes("Unknown interaction") || text.includes("Interaction has already been acknowledged")) {
      onWarning?.(`discord-port ignored stale interaction error: ${text}`);
      return;
    }
    onError?.(`discord-port client error: ${text}`);
  });
}

export async function startDiscordPortBot({
  token,
  adapter,
  client,
  enableMessageContent = true,
  onReload,
  onInfo,
  onWarning,
  onError,
}: {
  token: string;
  adapter: DiscordPortRuntimeAdapter;
  client?: Client;
  enableMessageContent?: boolean;
  onReload?: () => void;
  onInfo?: (message: string) => void;
  onWarning?: (message: string) => void;
  onError?: (message: string) => void;
}) {
  const resolvedClient = client ?? createDiscordPortClient(enableMessageContent);
  const runtime = new DiscordPortRuntime(resolvedClient, adapter);
  registerDiscordPortBot({
    client: resolvedClient,
    runtime,
    enableMessageContent,
    onReload,
    onInfo,
    onWarning,
    onError,
  });
  await resolvedClient.login(token);
  return { client: resolvedClient, runtime };
}
