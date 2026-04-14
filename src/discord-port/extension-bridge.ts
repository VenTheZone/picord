import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ChannelType, Events, type Client, type Guild } from "discord.js";
import { loadRuntimeConfig } from "../config.js";
import { type LiveDiscordRunRenderer, type PiLiveUpdate } from "../live-discord-renderer.js";
import { PiSessionPool } from "../pi-session.js";
import { clearRestartNotification, readRestartNotification } from "../restart-notification.js";
import { RuntimeLock } from "../runtime-lock.js";
import { sendTextResponse } from "./message-helpers.js";
import { PiSessionPoolAdapter } from "./pi-runtime-adapter.js";
import { buildDiscordPortCommands } from "./command-registration.js";
import { buildAllMultiAuthCommands } from "./multi-auth-commands.js";
import { createDiscordPortClient, startDiscordPortBot } from "./discord-bot.js";
import {
  AccountManager,
  registerMultiAuthProviders,
  unregisterGlobalKeyDistributor,
} from "./multi-auth-integration.js";
import { buildMultiAuthExtensionConfig } from "../multi-auth/picord-config-adapter.js";
import { multiAuthDebugLogger } from "../multi-auth/debug-logger.js";
import type { SupportedProviderId } from "../multi-auth/index-export.js";

export interface DiscordPortBridgeHandle {
  client?: Client;
  stop: () => Promise<void>;
}

function resolveRuntimeLockPath(statePath: string): string {
  return `${statePath}.lock`;
}

function getChannelIdFromConversationKey(conversationKey: string): string | undefined {
  const dmMatch = /^discord:dm:(.+)$/.exec(conversationKey);
  if (dmMatch) {
    return dmMatch[1];
  }

  const guildMatch = /^discord:guild:[^:]+:(thread|channel):(.+)$/.exec(conversationKey);
  return guildMatch?.[2];
}

async function resolveHostControlChannelId(config: { hostChannelId?: string; hostChannelName: string }, guild: Guild): Promise<string | undefined> {
  await guild.channels.fetch();

  if (config.hostChannelId) {
    const byId = guild.channels.cache.get(config.hostChannelId);
    if (byId?.type === ChannelType.GuildText) {
      return byId.id;
    }
  }

  const byName = guild.channels.cache.find((channel) => {
    return channel.type === ChannelType.GuildText && channel.name.toLowerCase() === config.hostChannelName;
  });
  return byName?.type === ChannelType.GuildText ? byName.id : undefined;
}

async function refreshHostControlChannels(config: { allowedGuildIds: string[]; hostChannelId?: string; hostChannelName: string }, discordClient: Client): Promise<string[]> {
  const messages: string[] = [];
  const guildIds = config.allowedGuildIds.length > 0
    ? config.allowedGuildIds
    : [...discordClient.guilds.cache.keys()];

  for (const guildId of guildIds) {
    const guild = await discordClient.guilds.fetch(guildId).catch(() => undefined);
    if (!guild) {
      continue;
    }

    const resolvedHostChannelId = await resolveHostControlChannelId(config, guild);
    if (!resolvedHostChannelId) {
      messages.push(`picord host control channel unresolved for ${guild.name}; expected #${config.hostChannelName}.`);
      continue;
    }

    const hostChannel = guild.channels.cache.get(resolvedHostChannelId);
    const hostLabel = hostChannel && "name" in hostChannel ? `#${hostChannel.name}` : resolvedHostChannelId;
    messages.push(`picord host control channel for ${guild.name}: ${hostLabel}`);
  }

  return messages;
}

async function ensureAllowedRolesExist(config: { allowedGuildIds: string[]; allowedRoleNames: string[] }, discordClient: Client): Promise<string[]> {
  const created: string[] = [];
  if (config.allowedRoleNames.length === 0) {
    return created;
  }

  const guildIds = config.allowedGuildIds.length > 0
    ? config.allowedGuildIds
    : [...discordClient.guilds.cache.keys()];

  for (const guildId of guildIds) {
    const guild = await discordClient.guilds.fetch(guildId).catch(() => undefined);
    if (!guild) {
      continue;
    }
    await guild.roles.fetch();
    const me = await guild.members.fetchMe().catch(() => undefined);
    if (!me?.permissions.has("ManageRoles")) {
      continue;
    }

    for (const roleName of config.allowedRoleNames) {
      const existing = guild.roles.cache.find((role) => role.name === roleName);
      if (existing) {
        continue;
      }
      await guild.roles.create({
        name: roleName,
        reason: "picord auto-created configured access role",
        mentionable: false,
        hoist: false,
      });
      created.push(`${guild.name}:${roleName}`);
    }
  }

  return created;
}

export async function startDiscordPortExtensionRuntime({
  pi,
  cwd,
  notify,
}: {
  pi: ExtensionAPI;
  cwd: string;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
}): Promise<DiscordPortBridgeHandle> {
  // Guard against unhandled rejections crashing the process
  const rejectionHandler = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    notify(`discord-port unhandled rejection: ${message}`, "error");
  };
  process.on("unhandledRejection", rejectionHandler);

  const exceptionHandler = (error: Error) => {
    notify(`discord-port uncaught exception: ${error.message}\n${error.stack ?? ""}`, "error");
  };
  process.on("uncaughtException", exceptionHandler);

  const config = loadRuntimeConfig(cwd);
  if (!config.isActive || !config.discordToken) {
    process.off("unhandledRejection", rejectionHandler);
    process.off("uncaughtException", exceptionHandler);
    notify("discord-port inactive: set PICORD_DISCORD_TOKEN to enable Discord.", "info");
    return { stop: async () => undefined };
  }

  const lockResult = RuntimeLock.acquire(resolveRuntimeLockPath(config.statePath));
  if (!lockResult.acquired) {
    process.off("unhandledRejection", rejectionHandler);
    process.off("uncaughtException", exceptionHandler);
    notify(`discord-port inactive: ${lockResult.reason}`, "warning");
    return { stop: async () => undefined };
  }

  let client: Client | undefined;
  const liveRenderers = new Map<string, { renderer: LiveDiscordRunRenderer; runId?: number }>();

  const notifyConversation = async (conversationKey: string, runId: number | undefined, update: PiLiveUpdate): Promise<void> => {
    const entry = liveRenderers.get(conversationKey);
    if (!entry) return;
    if (entry.runId !== undefined && runId !== undefined && entry.runId !== runId) return;
    await entry.renderer.onUpdate(update);
  };

  const notifyAccessRequest = async (conversationKey: string, content: string): Promise<void> => {
    const entry = liveRenderers.get(conversationKey);
    const requestId = content.match(/Request ID:\s*(acc-\d+)/)?.[1] || content.match(/Access request\s+(acc-\d+)/)?.[1];
    if (entry) {
      await entry.renderer.showAccessRequest(content, requestId);
      return;
    }

    const channelId = getChannelIdFromConversationKey(conversationKey);
    if (!channelId || !client) {
      notify(`discord-port could not deliver conversation notice for ${conversationKey}`, "warning");
      return;
    }

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !("send" in channel)) {
        notify(`discord-port channel ${channelId} is unavailable for conversation notice delivery`, "warning");
        return;
      }
      await sendTextResponse(channel, content);
    } catch (error) {
      notify(
        `discord-port failed to deliver conversation notice to ${channelId}: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  };

  const sessionPool = new PiSessionPool(config, notifyAccessRequest, notifyConversation);
  await sessionPool.initialize();
  const adapter = new PiSessionPoolAdapter(config, sessionPool, liveRenderers);

  let slashOnlyMode = false;
  let cleanedUp = false;
  let multiAuthAccountManager: AccountManager | undefined;

  const registerCommands = async (discordClient: Client) => {
    if (!config.registerCommands || !discordClient.application) return;
    const skillSummaries = adapter.listSkillSummaries();
    let providerList: SupportedProviderId[] = [];
    if (multiAuthAccountManager) {
      try {
        const allProviders = await multiAuthAccountManager.getSupportedProviders();
        const excludeSet = new Set(config.multiAuth?.excludeProviders ?? []);
        providerList = allProviders.filter(p => !excludeSet.has(p));
      } catch {
        // ignore errors
      }
    }
    const commands = [
      ...buildDiscordPortCommands(skillSummaries),
      ...buildAllMultiAuthCommands(providerList),
    ];
    if (config.allowedGuildIds.length > 0) {
      await Promise.all(config.allowedGuildIds.map((guildId) => discordClient.application!.commands.set(commands, guildId)));
      return;
    }
    await discordClient.application.commands.set(commands);
  };

  const cleanup = async (reason?: string) => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    process.off("unhandledRejection", rejectionHandler);
    process.off("uncaughtException", exceptionHandler);

    if (client) {
      await client.destroy().catch(() => undefined);
      client = undefined;
    }
    await sessionPool.dispose();
    if (multiAuthAccountManager) {
      try {
        unregisterGlobalKeyDistributor(multiAuthAccountManager.getKeyDistributor());
        multiAuthAccountManager.shutdown();
      } catch (err) {
        notify(`multi-auth shutdown warning: ${err instanceof Error ? err.message : String(err)}`, "warning");
      }
      multiAuthAccountManager = undefined;
    }
    lockResult.lock.release();
    if (reason) {
      notify(reason, "info");
    }
  };

  const start = async (enableMessageContent: boolean) => {
    const createdClient = createDiscordPortClient(enableMessageContent);
    createdClient.once(Events.ClientReady, async () => {
      try {
        const createdRoles = await ensureAllowedRolesExist(config, createdClient);
        const hostMessages = await refreshHostControlChannels(config, createdClient);

        // Initialize multi-auth for Codex rotation and usage tracking
        if (config.multiAuth?.enabled !== false) {
          const maConfig = buildMultiAuthExtensionConfig(config.multiAuth ?? {});
          multiAuthAccountManager = new AccountManager(undefined, undefined, undefined, undefined, undefined, maConfig);
          try {
            await registerMultiAuthProviders(pi, multiAuthAccountManager, {
              excludeProviders: config.multiAuth?.excludeProviders,
              onRotate: (oldId, newId, providerId, trigger) => {
                const failStr = trigger ? ` (${trigger})` : "";
                notify(`🔄 Rotating credential/provider for ${providerId}: ${oldId} ➔ ${newId}${failStr}`, "info");
              },
            });
          } catch (err) {
            notify(`multi-auth provider registration warning: ${err instanceof Error ? err.message : String(err)}`, "warning");
          }
          await multiAuthAccountManager.ensureInitialized();
          await multiAuthAccountManager.autoActivatePreferredCredentials({ avoidUsageApi: true }).catch((err) => {
            notify(`multi-auth warmup warning: ${err.message}`, "warning");
          });
          multiAuthDebugLogger.initialize(true);
          notify("multi-auth credentials loaded.", "info");
        }

        await registerCommands(createdClient);
        if (createdRoles.length > 0) {
          notify(`picord auto-created roles: ${createdRoles.join(", ")}`, "info");
        }
        for (const hostMessage of hostMessages) {
          notify(hostMessage, hostMessage.includes("unresolved") ? "warning" : "info");
        }

        const restartNotification = readRestartNotification(config.statePath);
        if (restartNotification) {
          try {
            const channel = await createdClient.channels.fetch(restartNotification.channelId);
            if (!channel || !("send" in channel)) {
              throw new Error(`Channel ${restartNotification.channelId} is unavailable`);
            }

            await sendTextResponse(
              channel,
              restartNotification.requestedByTag
                ? `✅ Picord is back online. Restart requested by ${restartNotification.requestedByTag}.`
                : "✅ Picord is back online.",
            );
            clearRestartNotification(config.statePath);
          } catch (error) {
            notify(`discord-port could not deliver restart notification: ${error instanceof Error ? error.message : String(error)}`, "warning");
          }
        }
      } catch (error) {
        notify(`discord-port command registration failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      notify(
        `discord-port connected as ${createdClient.user?.tag ?? "Discord bot"} (${enableMessageContent ? "full mode" : "slash-only mode"})`,
        "info",
      );
    });

    const started = await startDiscordPortBot({
      token: config.discordToken!,
      adapter,
      client: createdClient,
      enableMessageContent,
      onReload: () => {
        pi.sendUserMessage("/picord-reload", { deliverAs: "followUp" });
      },
      onWarning: (message) => notify(message, "warning"),
      onError: (message) => notify(message, "error"),
      multiAuthAccountManager,
    });
    client = started.client;
  };

  try {
    await start(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Used disallowed intents")) {
      await cleanup();
      throw error;
    }

    slashOnlyMode = true;
    notify("discord-port Message Content intent unavailable; falling back to slash-only mode.", "warning");
    if (client) {
      await client.destroy().catch(() => undefined);
      client = undefined;
    }
    await start(false);
  }

  return {
    client,
    stop: async () => {
      await cleanup();
    },
  };
}
