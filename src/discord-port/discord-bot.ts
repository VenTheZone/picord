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
import {
  LiveDiscordRunRenderer,
  createChannelLiveMessageTarget,
} from "../live-discord-renderer.js";
import { canAccessDiscordMessage } from "./access-control.js";
import { buildPromptFromMessage, replyToMessage } from "./message-helpers.js";
import { registerDiscordPortInteractionHandler } from "./interaction-handler.js";
import { DiscordPortRuntime } from "./runtime.js";
import type { DiscordPortRuntimeAdapter } from "./types.js";
import type { AccountManager } from "./multi-auth-integration.js";

/**
 * Truncate error messages for display, especially rate limit errors.
 */
function truncateErrorMessage(text: string): string {
  // Check for rate limit / quota errors
  if (/\b429\b/i.test(text) || /rate.limit|quota.exceeded|too.many.requests/i.test(text)) {
    // Extract the core error message for 429s
    const match = text.match(/429[^\n]*/i) || text.match(/rate.limit[^\n]*/i) || text.match(/Too many[^\n]*/i);
    if (match) {
      return `Provider Error: ${match[0].slice(0, 200)}`;
    }
    return `Provider Error: Rate limited. Please wait and try again.`;
  }
  // Truncate long error messages
  if (text.length > 500) {
    return `${text.slice(0, 497)}...`;
  }
  return text;
}

function isThreadChannel(channel: Message["channel"]): boolean {
  return (
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread
  );
}

function isProjectTextChannel(
  channel: Message["channel"],
  runtime: DiscordPortRuntime,
): channel is TextChannel {
  return (
    channel.type === ChannelType.GuildText &&
    runtime.adapter.isManagedProjectChannel(channel.id)
  );
}

function buildAutoThreadName(message: Message): string {
  const normalized = message.content
    .replace(/<@!?(\d+)>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || "picord session").slice(0, 80);
}

function isHostControlChannel(
  message: Message,
  runtime: DiscordPortRuntime,
): boolean {
  if (!message.inGuild()) {
    return false;
  }

  if (runtime.adapter.config.hostChannelId) {
    return message.channelId === runtime.adapter.config.hostChannelId;
  }

  return (
    message.channel.type === ChannelType.GuildText &&
    message.channel.name.toLowerCase() ===
      runtime.adapter.config.hostChannelName
  );
}

export function createDiscordPortClient(
  enableMessageContent: boolean = true,
): Client {
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
  multiAuthAccountManager,
}: {
  client: Client;
  runtime: DiscordPortRuntime;
  enableMessageContent?: boolean;
  onReload?: () => void;
  onInfo?: (message: string) => void;
  onWarning?: (message: string) => void;
  onError?: (message: string) => void;
  multiAuthAccountManager?: AccountManager;
}) {
  registerDiscordPortInteractionHandler({
    client,
    runtime,
    _onReload: onReload,
    multiAuthAccountManager,
  });
  const latestRunIds = new Map<string, number>();

  const nextRunId = (conversationKey: string): number => {
    const runId = (latestRunIds.get(conversationKey) ?? 0) + 1;
    latestRunIds.set(conversationKey, runId);
    return runId;
  };

  const isLatestRun = (conversationKey: string, runId: number): boolean =>
    latestRunIds.get(conversationKey) === runId;

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

        const access = await canAccessDiscordMessage(
          runtime.adapter.config,
          runtime.adapter,
          message,
        );
        if (!access.allowed) {
          await replyToMessage(
            message,
            access.reason ?? "You are not allowed to use this bot here.",
          );
          return;
        }

        if (!message.inGuild()) {
          const conversationKey = `discord:dm:${message.channelId}`;

          if (runtime.adapter.isStreaming(conversationKey)) {
            // Seal old renderer so its message stops updating, then abort
            // the agent and wait for old respond() to fully exit before
            // starting a new one. This ensures the new bot message appears
            // BELOW the user's message, not above it.
            await runtime.adapter.sealLiveRenderer(conversationKey);
            runtime.adapter.clearLiveRenderer(conversationKey);
            await runtime.adapter.abort(conversationKey).catch(() => false);
            await runtime.adapter.waitForRespondDone(conversationKey);
          }

          if ("sendTyping" in message.channel) {
            await message.channel.sendTyping().catch(() => undefined);
          }

          const runId = nextRunId(conversationKey);
          const thinkingVisible = runtime.adapter.getThinkingVisibility(conversationKey);
          const renderer = new LiveDiscordRunRenderer(
            createChannelLiveMessageTarget(message.channel),
            { thinkingVisible },
          );
          runtime.adapter.registerLiveRenderer(
            conversationKey,
            renderer,
            runId,
          );
          try {
            const dmResponse = await runtime.adapter.respond({
              conversationKey,
              workspaceKey: `discord:dm:${message.channelId}`,
              sessionName: `dm-${message.author.username}`,
              promptText: buildPromptFromMessage(message, promptText),
              runId,
            });
            if (!isLatestRun(conversationKey, runId)) {
              return;
            }
            await renderer.finalize(dmResponse);
          } catch (error) {
            if (!isLatestRun(conversationKey, runId)) {
              return;
            }
            throw error;
          } finally {
            runtime.adapter.clearLiveRenderer(conversationKey, renderer);
          }
          return;
        }

        if (isHostControlChannel(message, runtime)) {
          return;
        }

        if (isThreadChannel(message.channel)) {
          const thread = message.channel as Parameters<
            typeof runtime.continueThread
          >[0]["thread"];
          const binding = runtime.bindThread(thread);

          if (runtime.adapter.isStreaming(binding.conversationKey)) {
            // Seal old renderer so its message stops updating, then abort
            // the agent and wait for old respond() to fully exit before
            // starting a new one. This ensures the new bot message appears
            // BELOW the user's message, not above it.
            await runtime.adapter.sealLiveRenderer(binding.conversationKey);
            runtime.adapter.clearLiveRenderer(binding.conversationKey);
            await runtime.adapter
              .abort(binding.conversationKey)
              .catch(() => false);
            await runtime.adapter.waitForRespondDone(
              binding.conversationKey,
            );
          }

          if ("sendTyping" in message.channel) {
            await message.channel.sendTyping().catch(() => undefined);
          }

          const runId = nextRunId(binding.conversationKey);
          const thinkingVisible = runtime.adapter.getThinkingVisibility(binding.conversationKey);
          const renderer = new LiveDiscordRunRenderer(
            createChannelLiveMessageTarget(thread),
            { thinkingVisible },
          );
          runtime.adapter.registerLiveRenderer(
            binding.conversationKey,
            renderer,
            runId,
          );
          try {
            const response = await runtime.adapter.respond({
              conversationKey: binding.conversationKey,
              workspaceKey: binding.workspaceKey,
              sessionName: binding.sessionName,
              promptText: buildPromptFromMessage(message, promptText),
              runId,
            });
            if (!isLatestRun(binding.conversationKey, runId)) {
              return;
            }
            await renderer.finalize(response);
          } catch (error) {
            if (!isLatestRun(binding.conversationKey, runId)) {
              return;
            }
            throw error;
          } finally {
            runtime.adapter.clearLiveRenderer(
              binding.conversationKey,
              renderer,
            );
          }
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

        const binding = runtime.bindThread(thread);
        const runId = nextRunId(binding.conversationKey);
        const thinkingVisible = runtime.adapter.getThinkingVisibility(binding.conversationKey);
        const renderer = new LiveDiscordRunRenderer(
          createChannelLiveMessageTarget(thread),
          { thinkingVisible },
        );
        runtime.adapter.registerLiveRenderer(
          binding.conversationKey,
          renderer,
          runId,
        );
        try {
          const response = await runtime.adapter.respond({
            conversationKey: binding.conversationKey,
            workspaceKey: binding.workspaceKey,
            sessionName: binding.sessionName,
            promptText: [
              buildPromptFromMessage(message, promptText),
              "",
              `[Session thread context]`,
              `ThreadId: ${thread.id}`,
              `WorkspaceChannel: ${thread.parentId ?? "unknown"}`,
            ].join("\n"),
            runId,
          });
          if (!isLatestRun(binding.conversationKey, runId)) {
            return;
          }
          await renderer.finalize(response);
        } catch (error) {
          if (!isLatestRun(binding.conversationKey, runId)) {
            return;
          }
          throw error;
        } finally {
          runtime.adapter.clearLiveRenderer(binding.conversationKey, renderer);
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        const truncatedText = truncateErrorMessage(text);
        onError?.(`discord-port message flow error: ${truncatedText}`);
        await replyToMessage(message, `picord error: ${truncatedText}`).catch(
          () => undefined,
        );
      }
    });
  }

  client.once(Events.ClientReady, () => {
    onInfo?.(`discord-port connected as ${client.user?.tag ?? "Discord bot"}`);
  });

  client.on(Events.Error, (error) => {
    const text = error instanceof Error ? error.message : String(error);
    const truncatedText = truncateErrorMessage(text);
    if (
      text.includes("Unknown interaction") ||
      text.includes("Interaction has already been acknowledged")
    ) {
      onWarning?.(`discord-port ignored stale interaction error: ${text}`);
      return;
    }
    onError?.(`discord-port client error: ${truncatedText}`);
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
  multiAuthAccountManager,
}: {
  token: string;
  adapter: DiscordPortRuntimeAdapter;
  client?: Client;
  enableMessageContent?: boolean;
  onReload?: () => void;
  onInfo?: (message: string) => void;
  onWarning?: (message: string) => void;
  onError?: (message: string) => void;
  multiAuthAccountManager?: AccountManager;
}) {
  const resolvedClient =
    client ?? createDiscordPortClient(enableMessageContent);
  const runtime = new DiscordPortRuntime(resolvedClient, adapter);
  registerDiscordPortBot({
    client: resolvedClient,
    runtime,
    enableMessageContent,
    onReload,
    onInfo,
    onWarning,
    onError,
    multiAuthAccountManager,
  });
  await resolvedClient.login(token);
  return { client: resolvedClient, runtime };
}
