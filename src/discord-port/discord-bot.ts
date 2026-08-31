import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ThreadAutoArchiveDuration,
  type Message,
  type OmitPartialGroupDMChannel,
  type TextChannel,
} from "discord.js";
import {
  LiveDiscordRunRenderer,
  createChannelLiveMessageTarget,
} from "../live-discord-renderer.js";
import { canAccessDiscordMessage } from "./access-control.js";
import { buildPromptFromMessage, replyToMessage, startTypingLoop } from "./message-helpers.js";
import { runBackfill } from "./backfill.js";
import { registerDiscordPortInteractionHandler } from "./interaction-handler.js";
import { DiscordPortRuntime } from "./runtime.js";
import type { DiscordPortRuntimeAdapter } from "./types.js";
import type { AccountManager } from "./multi-auth-integration.js";

/**
 * Truncate error messages for display, especially rate limit errors.
 * By default, shows compact 1-line summary. Verbose mode shows full error.
 */
export function truncateErrorMessage(text: string, verbose = false): string {
  if (verbose) {
    return text.length > 1900 ? `${text.slice(0, 1897)}...` : text;
  }

  // Rate limit errors - ultra compact
  if (/\b429\b/i.test(text) || /rate.limit|quota.exceeded/i.test(text)) {
    return "Provider Error: Rate limited.";
  }

  // Multi-auth errors - extract provider name only
  if (/multi-auth rotation/i.test(text)) {
    const m = text.match(/failed for ([\w-]+):/i);
    return m ? `Provider Error: ${m[1]} auth failed.` : "Provider Error: Auth failed.";
  }

  // Discord API errors - hide technical noise
  if (/Unknown Message/i.test(text)) {
    return "Message was deleted or unavailable.";
  }
  if (/Unknown Interaction|Interaction has already been acknowledged/i.test(text)) {
    return "Interaction expired. Please retry the command.";
  }

  // Default: first sentence only, max 150 chars
  const sentence = (text.split(/[.\n]/)[0] || "").trim().replace(/\s+/g, " ");
  return sentence.length > 150 ? sentence.slice(0, 147) + "..." : sentence;
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

// Reaction-as-status lifecycle ported from hermes adapter (processing ack ->
// outcome). Cheap, visible progress signal; all failures ignored — reactions
// are best-effort.
async function ackReaction(message: Message): Promise<void> {
  try {
    await message.react("👀");
  } catch {
    /* reactions best-effort */
  }
}

async function finishReaction(message: Message, ok: boolean): Promise<void> {
  try {
    await message.reactions?.removeAll();
    await message.react(ok ? "✅" : "❌");
  } catch {
    /* reactions best-effort */
  }
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

  // Dedup claim (hermes #51057): after startThread(), Discord re-fires the
  // starter message as a MESSAGE_CREATE inside the thread whose id ==
  // thread.id. Without this, every auto-thread prompt runs twice. Also gates
  // backfill re-dispatch against live events.
  // ponytail: FIFO eviction at 1000 ids; timestamped TTL if bots share state.
  const seenIds = new Set<string>();
  const claim = (id: string): boolean => {
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    if (seenIds.size > 1000) seenIds.delete(seenIds.values().next().value as string);
    return true;
  };

  if (enableMessageContent) {
    // Incoming chunk re-batching (ported from hermes adapter): Discord splits
    // user messages >2000 chars into several MESSAGE_CREATE events arriving ms
    // apart. Without merging, each chunk aborts the previous run and becomes a
    // separate prompt. Buffer per channel+author; extend the window when the
    // last chunk is near the 2000 cap (continuation is then near-certain).
    const SPLIT_THRESHOLD = 1900;
    const BATCH_WINDOW_MS = 600;
    const BATCH_EXTEND_MS = 2000;
    type PortMessage = OmitPartialGroupDMChannel<Message>;
    interface PendingBatch { message: PortMessage; text: string; timer: NodeJS.Timeout }
    const batches = new Map<string, PendingBatch>();

    const processMessage = async (message: PortMessage, mergedText?: string): Promise<void> => {
      try {
        if (message.author.bot) {
          return;
        }

        const promptText = (mergedText ?? message.content).trim();
        if (!promptText && message.attachments.size === 0) {
          return;
        }

        const access = await canAccessDiscordMessage(
          runtime.adapter.config,
          runtime.adapter,
          message,
        );
        if (!access.allowed) {
          // Only explain the denial when the bot is explicitly mentioned;
          // otherwise stay silent so the channel isn't spammed.
          if (message.mentions.has(client.user?.id ?? "")) {
            await replyToMessage(
              message,
              access.reason ?? "You are not allowed to use this bot here.",
            );
          }
          return;
        }

        if (!message.inGuild()) {
          const conversationKey = `discord:dm:${message.channelId}`;

          // Always abort first to clear any stuck state, then respond.
          await runtime.adapter.sealLiveRenderer(conversationKey);
          runtime.adapter.clearLiveRenderer(conversationKey);
          await runtime.adapter.abort(conversationKey).catch(() => false);
          await runtime.adapter.waitForRespondDone(conversationKey);

          await ackReaction(message);
          const stopTyping = startTypingLoop(message.channel);

          const runId = nextRunId(conversationKey);
          const thinkingVisible = runtime.adapter.getThinkingVisibility(conversationKey);
          const renderer = new LiveDiscordRunRenderer(
            createChannelLiveMessageTarget(message.channel),
            { thinkingVisible },
          );
      // Show placeholder immediately for perceived responsiveness.
      await renderer.showThinkingPlaceholder().catch(() => undefined);
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
            await finishReaction(message, true);
          } catch (error) {
            if (!isLatestRun(conversationKey, runId)) {
              return;
            }
            console.error(`[picord] DM respond failed:`, error);
            await renderer.finalize(`❌ ${truncateErrorMessage(String(error))}`).catch(() => undefined);
            await finishReaction(message, false);
            return;
          } finally {
            stopTyping();
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
          // Unarchive if the thread lapsed into archive while idle, so the
          // response isn't rejected with Discord's archived-thread error.
          if (thread.archived) {
            await thread.setArchived(false).catch(() => undefined);
          }
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

          await ackReaction(message);
          const stopTyping = startTypingLoop(message.channel);

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
            await finishReaction(message, true);
          } catch (error) {
            if (!isLatestRun(binding.conversationKey, runId)) {
              return;
            }
            console.error(`[picord] thread respond failed:`, error);
            await renderer.finalize(`❌ ${truncateErrorMessage(String(error))}`).catch(() => undefined);
            await finishReaction(message, false);
            return;
          } finally {
            stopTyping();
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

        // Only auto-create threads when the bot is mentioned, so channel
        // chatter doesn't spawn sessions.
        if (!message.mentions.has(client.user?.id ?? "")) {
          return;
        }

        const thread = await message.startThread({
          name: buildAutoThreadName(message),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: "picord auto-started session thread",
        });
        seenIds.add(thread.id); // duplicate starter-message event has id == thread.id
        await thread.members.add(message.author.id).catch(() => undefined);

        const stopTyping = startTypingLoop(thread);

        const binding = runtime.bindThread(thread);
        const runId = nextRunId(binding.conversationKey);
        const thinkingVisible = runtime.adapter.getThinkingVisibility(binding.conversationKey);
        const renderer = new LiveDiscordRunRenderer(
          createChannelLiveMessageTarget(thread),
          { thinkingVisible },
        );
        // Show placeholder immediately so user sees feedback while
        // workspace loads + session initializes (1-3s cold start).
        await renderer.showThinkingPlaceholder().catch(() => undefined);
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
          await finishReaction(message, true);
        } catch (error) {
          if (!isLatestRun(binding.conversationKey, runId)) {
            return;
          }
          console.error(`[picord] project-channel respond failed:`, error);
          await renderer.finalize(`❌ ${truncateErrorMessage(String(error))}`).catch(() => undefined);
          await finishReaction(message, false);
          return;
        } finally {
          stopTyping();
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
    };

    client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;
      if (!claim(message.id)) return;
      const key = `${message.channelId}:${message.author.id}`;
      const pending = batches.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        batches.delete(key);
        pending.text = `${pending.text}\n${message.content}`;
        if (message.content.length >= SPLIT_THRESHOLD) {
          // Still at the cap — more chunks likely; keep buffering.
          pending.timer = setTimeout(() => {
            batches.delete(key);
            void processMessage(pending.message, pending.text);
          }, BATCH_EXTEND_MS);
          batches.set(key, pending);
          return;
        }
        await processMessage(pending.message, pending.text);
        return;
      }
      if (message.content.length < SPLIT_THRESHOLD) {
        // Not a split message — dispatch with zero added latency.
        await processMessage(message);
        return;
      }
      const batch: PendingBatch = {
        message,
        text: message.content,
        timer: setTimeout(() => {
          batches.delete(key);
          void processMessage(message);
        }, BATCH_WINDOW_MS),
      };
      batches.set(key, batch);
    });

  if (enableMessageContent) {
    // Backfill on every fresh identify (hermes recovery.py): discord.js
    // self-reconnects the WS, but messages missed while offline are never
    // replayed — rescan after each ClientReady. In-flight guard keeps
    // reconnect storms from stacking scans.
    let backfillRunning = false;
    client.on(Events.ClientReady, () => {
      if (backfillRunning) return;
      backfillRunning = true;
      void runBackfill(
        client,
        runtime.adapter.config,
        runtime.adapter.listManagedProjects().map((project) => project.channelId),
        async (channelId, messageId) => {
          // Claim the raw id: a live MESSAGE_CREATE racing the scan must lose.
          if (!claim(messageId)) return;
          const channel = await client.channels.fetch(channelId);
          if (!channel || !("messages" in channel)) return;
          const recovered = await channel.messages.fetch(messageId);
          if (!recovered || recovered.author.bot) return;
          await processMessage(
            recovered as Parameters<typeof processMessage>[0],
            `[Recovered after downtime] ${recovered.content}`,
          );
        },
        (msg) => onError?.(msg),
      )
        .then((count) => {
          if (count > 0) onInfo?.(`backfill: re-dispatched ${count} missed message(s)`);
        })
        .catch((error) => {
          onError?.(`backfill: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          backfillRunning = false;
        });
    });
  }
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

  // WS liveness watchdog (hermes adapter.py:1909): discord.js self-reconnects
  // while status flips, but a wedged client can sit non-READY indefinitely
  // with REST still working — messages silently stop. After STALE_MS off
  // READY, hard-destroy + fresh login (which also re-triggers backfill).
  // ponytail: status-based; add heartbeat-ack-age sampling if wedges ever
  // show up while status stays READY.
  const STALE_MS = 5 * 60_000;
  let lastNonReady = resolvedClient.isReady() ? 0 : Date.now();
  resolvedClient.on(Events.ShardDisconnect, () => {
    if (!lastNonReady) lastNonReady = Date.now();
  });
  resolvedClient.on(Events.ClientReady, () => {
    lastNonReady = 0;
  });
  let warned = false;
  const watchdog = setInterval(() => {
    if (!lastNonReady || Date.now() - lastNonReady < STALE_MS) {
      warned = false;
      return;
    }
    if (!warned) {
      warned = true;
      onWarning?.("discord-port: gateway not READY for 5m — forcing reconnect");
    }
    resolvedClient.destroy().catch(() => undefined);
    void resolvedClient.login(token).then(
      () => {
        lastNonReady = 0;
        warned = false;
      },
      (error) => {
        onError?.(`discord-port re-login failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }, 30_000);
  watchdog.unref?.();

  return { client: resolvedClient, runtime };
}
