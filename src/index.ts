import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  Partials,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { canAccessDm, canAccessGuild } from "./auth.js";
import { toDiscordChunks } from "./conversation.js";
import { loadRuntimeConfig } from "./config.js";
import discordPortExtension from "./discord-port/entrypoint.js";
import { buildAllMultiAuthCommands, handleMultiAuthCommand } from "./discord-port/multi-auth-commands.js";
import {
  AccountManager,
  registerGlobalKeyDistributor,
  unregisterGlobalKeyDistributor,
  registerMultiAuthProviders,
  initMultiAuthConfig,
  multiAuthDebugLogger,
} from "./discord-port/multi-auth-integration.js";
import { isEncryptionAvailable } from "./crypto/encryption.js";
import { LiveDiscordRunRenderer, createChannelLiveMessageTarget, createInteractionLiveMessageTarget, type PiLiveUpdate } from "./live-discord-renderer.js";
import { PiSessionPool } from "./pi-session.js";
import { resolveRuntimeArch } from "./runtime-arch.js";
import { RuntimeLock } from "./runtime-lock.js";
import type { PicordRuntimeConfig, SkillSummary } from "./types.js";
import type { SupportedProviderId } from "./multi-auth/index-export.js";

const RESERVED_COMMAND_NAMES = new Set([
  "ask",
  "abort",
  "reset",
  "resume",
  "status",
  "models",
  "scope-models",
  "use-model",
  "reload",
  "project-create",
  "project-list",
  "access-requests",
  "multi-auth",
  "multi-auth-delete",
  "multi-auth-switch",
  "multi-auth-auto",
  "multi-auth-rename",
  "multi-auth-rotation",
  "multi-auth-hide",
]);

const OWNER_ADMIN_COMMAND_NAMES = new Set([
  "reload",
  "project-create",
  "project-list",
  "access-requests",
]);

const PICORD_CATEGORY_NAME = "Picord";

function truncateDescription(description: string): string {
  return description.length <= 100 ? description : `${description.slice(0, 97)}...`;
}

function buildAskCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask pi in the current Discord session")
    .addStringOption((option) =>
      option.setName("prompt").setDescription("Prompt to send to pi").setRequired(true),
    )
    .toJSON();
}

function buildAbortCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("abort")
    .setDescription("Abort the active pi run in the current thread session")
    .toJSON();
}

function buildResetCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Reset the current pi session")
    .toJSON();
}

function buildResumeCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Bind this thread to an existing pi session")
    .addStringOption((option) =>
      option
        .setName("session")
        .setDescription("Existing pi session file path or session ID")
        .setRequired(true),
    )
    .toJSON();
}

function buildStatusCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder().setName("status").setDescription("Show picord status").toJSON();
}

function buildModelsCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder().setName("models").setDescription("List workspace models").toJSON();
}

function buildScopeModelsCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("scope-models")
    .setDescription("Show or change the workspace model scope")
    .addStringOption((option) =>
      option
        .setName("patterns")
        .setDescription("Patterns like anthropic/* openai/gpt-* or 'clear'")
        .setRequired(false),
    )
    .toJSON();
}

function buildUseModelCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("use-model")
    .setDescription("Set the active workspace model")
    .addStringOption((option) =>
      option
        .setName("model")
        .setDescription("Model reference in provider/model-id form")
        .setRequired(true),
    )
    .toJSON();
}

function buildReloadCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder().setName("reload").setDescription("Reload picord runtime").toJSON();
}

function buildProjectCreateCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("project-create")
    .setDescription("Create a managed project channel and workspace mapping")
    .addStringOption((option) =>
      option.setName("name").setDescription("Project name for the Discord channel and workspace folder").setRequired(true),
    )
    .toJSON();
}

function buildProjectListCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("project-list")
    .setDescription("List managed project channels and workspace mappings")
    .toJSON();
}

function buildAccessRequestsCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("access-requests")
    .setDescription("List pending access requests")
    .toJSON();
}

function buildSkillCommand(skill: SkillSummary): RESTPostAPIChatInputApplicationCommandsJSONBody | undefined {
  if (RESERVED_COMMAND_NAMES.has(skill.name)) return undefined;
  if (!/^[a-z0-9-]{1,32}$/.test(skill.name)) return undefined;

  return new SlashCommandBuilder()
    .setName(skill.name)
    .setDescription(truncateDescription(skill.description || `Invoke the ${skill.name} skill`))
    .addStringOption((option) =>
      option.setName("prompt").setDescription("Optional arguments for the skill").setRequired(false),
    )
    .toJSON();
}

async function buildSlashCommands(
  skills: SkillSummary[],
  providerList: SupportedProviderId[] = [],
): Promise<RESTPostAPIChatInputApplicationCommandsJSONBody[]> {
  const baseCommands = [
    buildAskCommand(),
    buildAbortCommand(),
    buildResetCommand(),
    buildResumeCommand(),
    buildStatusCommand(),
    buildModelsCommand(),
    buildScopeModelsCommand(),
    buildUseModelCommand(),
    buildReloadCommand(),
    buildProjectCreateCommand(),
    buildProjectListCommand(),
    buildAccessRequestsCommand(),
  ];

  const skillCommands = skills.map(buildSkillCommand).filter(Boolean) as RESTPostAPIChatInputApplicationCommandsJSONBody[];

  return [
    ...baseCommands,
    ...buildAllMultiAuthCommands(providerList),
    ...skillCommands,
  ];
}

function isThreadChannelType(type: ChannelType | null | undefined): boolean {
  return type === ChannelType.PublicThread || type === ChannelType.PrivateThread;
}

function isThreadLikeChannel(channel: { type?: ChannelType | null }): channel is {
  type: ChannelType.PublicThread | ChannelType.PrivateThread;
  id: string;
  name: string;
  parentId: string | null;
} {
  return isThreadChannelType(channel.type);
}

function getWorkspaceChannelIdFromMessage(message: Message): string {
  return isThreadLikeChannel(message.channel) ? (message.channel.parentId ?? message.channelId) : message.channelId;
}

function getWorkspaceChannelIdFromInteraction(interaction: ChatInputCommandInteraction): string {
  return interaction.channel && isThreadLikeChannel(interaction.channel)
    ? (interaction.channel.parentId ?? interaction.channelId)
    : interaction.channelId;
}

function getWorkspaceKeyFromMessage(message: Message): string {
  if (!message.guildId) {
    return `discord:dm:${message.channelId}`;
  }
  return `discord:guild:${message.guildId}:workspace:${getWorkspaceChannelIdFromMessage(message)}`;
}

function getWorkspaceKeyFromInteraction(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) {
    return `discord:dm:${interaction.channelId}`;
  }
  return `discord:guild:${interaction.guildId}:workspace:${getWorkspaceChannelIdFromInteraction(interaction)}`;
}

function getConversationKeyFromMessage(message: Message): string {
  if (!message.guildId) {
    return `discord:dm:${message.channelId}`;
  }
  if (isThreadChannelType(message.channel.type)) {
    return `discord:guild:${message.guildId}:thread:${message.channel.id}`;
  }
  return `discord:guild:${message.guildId}:channel:${message.channelId}`;
}

function getConversationKeyFromInteraction(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) {
    return `discord:dm:${interaction.channelId}`;
  }
  if (isThreadChannelType(interaction.channel?.type)) {
    return `discord:guild:${interaction.guildId}:thread:${interaction.channelId}`;
  }
  return `discord:guild:${interaction.guildId}:channel:${interaction.channelId}`;
}

function getSessionNameFromMessage(message: Message): string {
  if (!message.guildId) {
    return `dm-${message.author.username}`;
  }
  if (isThreadLikeChannel(message.channel)) {
    return message.channel.name;
  }
  return message.channelId;
}

function buildAutoThreadName(sourceText: string): string {
  const normalized = sourceText
    .replace(/<@!?(\d+)>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const base = normalized || "picord session";
  return base.slice(0, 80);
}

function getSessionNameFromInteraction(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) {
    return `dm-${interaction.user.username}`;
  }
  if (interaction.channel && isThreadLikeChannel(interaction.channel)) {
    return interaction.channel.name;
  }
  return interaction.channelId;
}

function isProjectWorkspaceChannel(channelId: string, config: PicordRuntimeConfig): boolean {
  return config.allowedChannelIds.includes(channelId) && channelId !== config.hostChannelId;
}

function extractMemberRoleIds(member: Message["member"] | ChatInputCommandInteraction["member"]): string[] {
  if (!member) return [];

  if (member instanceof GuildMember) {
    return [...member.roles.cache.keys()];
  }

  if (typeof member === "object" && member !== null && "roles" in member && Array.isArray(member.roles)) {
    return member.roles.filter((roleId): roleId is string => typeof roleId === "string");
  }

  return [];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function resolveAllowedRoleIds(config: PicordRuntimeConfig, guild: Guild | null): Promise<string[]> {
  const roleIds = [...config.allowedRoleIds];
  if (!guild || config.allowedRoleNames.length === 0) {
    return unique(roleIds);
  }

  await guild.roles.fetch();
  for (const roleName of config.allowedRoleNames) {
    const matched = guild.roles.cache.find((role) => role.name === roleName);
    if (matched) {
      roleIds.push(matched.id);
    }
  }

  return unique(roleIds);
}

async function buildEffectiveConfig(
  config: PicordRuntimeConfig,
  sessionPool: PiSessionPool,
  guild: Guild | null,
  resolvedHostChannelId?: string,
): Promise<PicordRuntimeConfig> {
  return {
    ...config,
    hostChannelId: resolvedHostChannelId ?? config.hostChannelId,
    allowedUserIds: unique([
      ...config.allowedUserIds,
      ...(config.ownerUserId ? [config.ownerUserId] : []),
    ]),
    allowedChannelIds: unique([
      ...config.allowedChannelIds,
      ...Object.keys(config.workspaceRoots),
      ...sessionPool.getManagedWorkspaceChannelIds(),
    ]),
    allowedRoleIds: await resolveAllowedRoleIds(config, guild),
  };
}

function normalizeProjectSlug(rawName: string): string {
  const slug = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 100);

  if (!slug) {
    throw new Error("Project name must include at least one letter or number.");
  }

  return slug;
}

function resolveManagedWorkspaceRoot(config: PicordRuntimeConfig, projectSlug: string): string {
  return path.join(config.workspaceBasePath, projectSlug);
}

function ensureDirectoryExists(targetPath: string): void {
  if (existsSync(targetPath)) {
    if (!statSync(targetPath).isDirectory()) {
      throw new Error(`Managed workspace path exists but is not a directory: ${targetPath}`);
    }
    return;
  }

  mkdirSync(targetPath, { recursive: true });
}

async function ensurePicordCategory(guild: Guild): Promise<string> {
  await guild.channels.fetch();
  const existing = guild.channels.cache.find((channel) => {
    return channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === PICORD_CATEGORY_NAME.toLowerCase();
  });
  if (existing?.type === ChannelType.GuildCategory) {
    return existing.id;
  }

  const created = await guild.channels.create({
    name: PICORD_CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    reason: "picord managed project category",
  });
  return created.id;
}

async function ensureAllowedRolesExist(config: PicordRuntimeConfig, discordClient: Client): Promise<string[]> {
  const created: string[] = [];
  if (config.allowedRoleNames.length === 0) return created;

  for (const guildId of config.allowedGuildIds) {
    const guild = await discordClient.guilds.fetch(guildId);
    await guild.roles.fetch();
    const me = await guild.members.fetchMe();
    if (!me.permissions.has("ManageRoles")) {
      continue;
    }

    for (const roleName of config.allowedRoleNames) {
      const existing = guild.roles.cache.find((role) => role.name === roleName);
      if (existing) continue;
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

async function findExistingManagedProjectChannel(
  guild: Guild,
  sessionPool: PiSessionPool,
  channelName: string,
  workspaceRoot: string,
): Promise<{ channelId: string; root: string; name?: string } | undefined> {
  await guild.channels.fetch();

  for (const workspace of sessionPool.listManagedWorkspaces()) {
    if (workspace.root !== workspaceRoot && workspace.name !== channelName) {
      continue;
    }
    const channel = guild.channels.cache.get(workspace.channelId);
    if (channel?.type === ChannelType.GuildText) {
      return workspace;
    }
  }

  const fallback = guild.channels.cache.find((channel) => {
    return channel.type === ChannelType.GuildText
      && channel.name === channelName
      && channel.topic === `picord workspace → ${workspaceRoot}`;
  });
  if (fallback?.type === ChannelType.GuildText) {
    return { channelId: fallback.id, root: workspaceRoot, name: channelName };
  }

  return undefined;
}

function buildPromptFromMessage(message: Message, promptText: string): string {
  const attachments = [...message.attachments.values()]
    .map((attachment) => `- ${attachment.name ?? "attachment"}: ${attachment.url}`)
    .join("\n");

  const contextLines = [
    "[Discord message]",
    `Author: ${message.author.tag} (${message.author.id})`,
    message.guild ? `Guild: ${message.guild.name} (${message.guild.id})` : "Guild: DM",
    `Channel: ${message.channel.id}`,
    isThreadLikeChannel(message.channel) ? `Thread: ${message.channel.name}` : undefined,
    `Timestamp: ${message.createdAt.toISOString()}`,
    attachments ? `Attachments:\n${attachments}` : undefined,
    "",
    promptText,
  ].filter((line): line is string => Boolean(line));

  return contextLines.join("\n");
}

function buildPromptFromInteraction(interaction: ChatInputCommandInteraction, promptText: string): string {
  const contextLines = [
    "[Discord slash command]",
    `Author: ${interaction.user.tag} (${interaction.user.id})`,
    interaction.guild ? `Guild: ${interaction.guild.name} (${interaction.guild.id})` : "Guild: DM",
    `Channel: ${interaction.channelId}`,
    interaction.channel && isThreadLikeChannel(interaction.channel)
      ? `Thread: ${interaction.channel.name}`
      : undefined,
    `Timestamp: ${new Date().toISOString()}`,
    "",
    promptText,
  ].filter((line): line is string => Boolean(line));

  return contextLines.join("\n");
}

async function sendTextResponse(
  channel: { send: (options: { content: string; allowedMentions: { parse: [] } }) => Promise<unknown> },
  content: string,
): Promise<void> {
  const chunks = toDiscordChunks(content);
  for (const chunk of chunks) {
    await channel.send({ content: chunk, allowedMentions: { parse: [] } });
  }
}

async function replyToMessage(message: Message, content: string): Promise<void> {
  const chunks = toDiscordChunks(content);
  const [firstChunk, ...remainingChunks] = chunks;
  if (!firstChunk) return;

  await message.reply({
    content: firstChunk,
    allowedMentions: { parse: [], repliedUser: false },
  });

  for (const chunk of remainingChunks) {
    if ("send" in message.channel) {
      await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  }
}

function buildStatusMessage(
  config: PicordRuntimeConfig,
  sessionPool: PiSessionPool,
  workspaceKey: string,
  conversationKey: string,
  sessionName: string,
  slashOnlyMode: boolean,
): string {
  const workspaceScope = sessionPool.getWorkspaceModelScope(workspaceKey);
  const workspaceInfo = sessionPool.getWorkspaceInfo(workspaceKey);

  return [
    "picord is connected.",
    `workspaceRoot: ${workspaceInfo.root}`,
    `toolMode: ${config.toolMode}`,
    `thinkingLevel: ${config.thinkingLevel}`,
    `activeSessions: ${sessionPool.getSessionCount()}`,
    `workspaceKey: ${workspaceKey}`,
    `conversationKey: ${conversationKey}`,
    `sessionName: ${sessionName}`,
    `sessionBound: ${sessionPool.hasSessionBinding(conversationKey)}`,
    `workspaceScopedModels: ${workspaceScope.models.length}`,
    `workspaceScopePatterns: ${workspaceScope.patterns.join(", ") || "(none)"}`,
    `blockedPathPatterns: ${sessionPool.getBlockedPathPatterns().join(", ")}`,
    `skills: ${sessionPool.getSkillSummaries().length}`,
    `ownerConfigured: ${Boolean(config.ownerUserId)}`,
    `hostChannelId: ${config.hostChannelId ?? "(unresolved)"}`,
    `slashOnlyMode: ${slashOnlyMode}`,
  ].join("\n");
}

function shouldUseEphemeral(interaction: ChatInputCommandInteraction): boolean {
  return interaction.inGuild();
}

function isOwnerAdminCommand(commandName: string): boolean {
  return OWNER_ADMIN_COMMAND_NAMES.has(commandName);
}

function resolveRuntimeLockPath(config: PicordRuntimeConfig): string {
  return `${config.statePath}.lock`;
}

function isHostControlChannel(
  interaction: ChatInputCommandInteraction,
  config: PicordRuntimeConfig,
): boolean {
  if (!interaction.inGuild()) return false;
  if (!interaction.channel || isThreadChannelType(interaction.channel.type)) return false;
  if (config.hostChannelId) {
    return interaction.channelId === config.hostChannelId;
  }
  return "name" in interaction.channel && typeof interaction.channel.name === "string"
    ? interaction.channel.name.toLowerCase() === config.hostChannelName
    : false;
}

function requireThreadForSessionCommand(interaction: ChatInputCommandInteraction): string | undefined {
  if (!interaction.guildId) return undefined;
  if (isThreadChannelType(interaction.channel?.type)) return undefined;
  return "Use this command inside a Discord thread. Project channel = workspace, thread = pi session.";
}

function isSkillCommand(commandName: string, sessionPool: PiSessionPool): SkillSummary | undefined {
  return sessionPool.getSkillSummaries().find((skill) => skill.name === commandName);
}

export default function picordExtension(pi: ExtensionAPI) {
  pi.registerCommand("picord-reload", {
    description: "Reload the picord Discord extension",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Reloading picord...", "info");
      await ctx.reload();
    },
  });

  if (resolveRuntimeArch(process.env) === "discord-port") {
    return discordPortExtension(pi);
  }

  let client: Client | undefined;
  let config: PicordRuntimeConfig | undefined;
  let sessionPool: PiSessionPool | undefined;
  let runtimeLock: RuntimeLock | undefined;
  let slashOnlyMode = false;
  let multiAuthAccountManager: AccountManager | undefined;
  const liveRenderers = new Map<string, { renderer: LiveDiscordRunRenderer; runId?: number }>();
  const conversationNoticeTargets = new Map<string, (content: string) => Promise<void>>();
  const hostControlChannels = new Map<string, string>();

  async function notifyConversation(conversationKey: string, runId: number | undefined, update: PiLiveUpdate): Promise<void> {
    const entry = liveRenderers.get(conversationKey);
    if (!entry) return;
    if (entry.runId !== undefined && runId !== undefined && entry.runId !== runId) return;
    await entry.renderer.onUpdate(update);
  }

  async function notifyAccessRequest(conversationKey: string, content: string): Promise<void> {
    const entry = liveRenderers.get(conversationKey);
    const requestId = content.match(/Request ID:\s*(acc-\d+)/)?.[1] || content.match(/Access request\s+(acc-\d+)/)?.[1];
    if (entry) {
      await entry.renderer.showAccessRequest(content, requestId);
      return;
    }

    const target = conversationNoticeTargets.get(conversationKey);
    if (!target) return;
    await target(content);
  }

  async function resolveHostControlChannelId(guild: Guild): Promise<string | undefined> {
    if (!config) return undefined;
    const currentConfig = config;

    const cached = hostControlChannels.get(guild.id);
    if (cached) {
      return cached;
    }

    await guild.channels.fetch();

    if (currentConfig.hostChannelId) {
      const byId = guild.channels.cache.get(currentConfig.hostChannelId);
      if (byId?.type === ChannelType.GuildText) {
        hostControlChannels.set(guild.id, byId.id);
        return byId.id;
      }
    }

    const byName = guild.channels.cache.find((channel) => {
      return channel.type === ChannelType.GuildText && channel.name.toLowerCase() === currentConfig.hostChannelName;
    });
    if (byName?.type === ChannelType.GuildText) {
      hostControlChannels.set(guild.id, byName.id);
      return byName.id;
    }

    return undefined;
  }

  async function refreshHostControlChannels(discordClient: Client): Promise<string[]> {
    if (!config) return [];

    const messages: string[] = [];
    const guildIds = config.allowedGuildIds.length > 0
      ? config.allowedGuildIds
      : [...discordClient.guilds.cache.keys()];

    hostControlChannels.clear();

    for (const guildId of guildIds) {
      const guild = await discordClient.guilds.fetch(guildId).catch(() => undefined);
      if (!guild) continue;

      const hostChannelId = await resolveHostControlChannelId(guild);
      if (!hostChannelId) {
        messages.push(`picord host control channel unresolved for ${guild.name}; expected #${config.hostChannelName}.`);
        continue;
      }

      const hostChannel = guild.channels.cache.get(hostChannelId);
      const hostLabel = hostChannel && "name" in hostChannel ? `#${hostChannel.name}` : hostChannelId;
      messages.push(`picord host control channel for ${guild.name}: ${hostLabel}`);
    }

    return messages;
  }

  async function registerCommandsIfEnabled(): Promise<void> {
    if (!client?.application || !config?.registerCommands || !sessionPool) return;

    let providerList: SupportedProviderId[] = [];
    if (multiAuthAccountManager) {
      try {
        const allProviders = await multiAuthAccountManager.getSupportedProviders();
        const excludeSet = new Set(config.multiAuth?.excludeProviders ?? []);
        providerList = allProviders.filter(p => !excludeSet.has(p));
      } catch {
        // ignore errors, proceed with empty list
      }
    }

    const commands = await buildSlashCommands(sessionPool.getSkillSummaries(), providerList);

    if (config.allowedGuildIds.length > 0) {
      await Promise.all(
        config.allowedGuildIds.map((guildId) => client!.application!.commands.set(commands, guildId)),
      );
      return;
    }

    await client.application.commands.set(commands);
  }

  async function handleDiscordMessage(message: Message): Promise<void> {
    if (!client?.user || !config || !sessionPool) return;
    if (message.author.bot) return;

    const isDm = !message.inGuild();
    const workspaceChannelId = getWorkspaceChannelIdFromMessage(message);
    const resolvedHostChannelId = message.guild ? await resolveHostControlChannelId(message.guild) : undefined;
    const effectiveConfig = await buildEffectiveConfig(config, sessionPool, message.guild ?? null, resolvedHostChannelId);
    const access = isDm
      ? canAccessDm(effectiveConfig, message.author.id)
      : canAccessGuild(effectiveConfig, {
          authorId: message.author.id,
          guildId: message.guildId!,
          channelId: workspaceChannelId,
          memberRoleIds: extractMemberRoleIds(message.member),
        });

    if (!access.allowed) {
      await replyToMessage(message, access.reason ?? "You are not allowed to use this bot here.");
      return;
    }

    const promptText = isDm ? message.content.trim() : message.content.trim();
    if (!promptText && message.attachments.size === 0) return;

    if (isDm) {
      if ("sendTyping" in message.channel) {
        await message.channel.sendTyping();
      }

      const conversationKey = getConversationKeyFromMessage(message);
      const renderer = new LiveDiscordRunRenderer(createChannelLiveMessageTarget(message.channel as never));
      liveRenderers.set(conversationKey, { renderer });
      conversationNoticeTargets.set(conversationKey, async (content) => {
        if ("send" in message.channel) {
          await sendTextResponse(message.channel, content);
        }
      });

      try {
        const response = await sessionPool.respond({
          conversationKey,
          workspaceKey: getWorkspaceKeyFromMessage(message),
          sessionName: getSessionNameFromMessage(message),
          promptText: buildPromptFromMessage(message, promptText),
        });
        await renderer.finalize(response);
      } finally {
        liveRenderers.delete(conversationKey);
        conversationNoticeTargets.delete(conversationKey);
      }
      return;
    }

    if (workspaceChannelId === effectiveConfig.hostChannelId) {
      return;
    }

    if (isThreadLikeChannel(message.channel)) {
      if ("sendTyping" in message.channel) {
        await message.channel.sendTyping();
      }

      const conversationKey = getConversationKeyFromMessage(message);
      const renderer = new LiveDiscordRunRenderer(createChannelLiveMessageTarget(message.channel as never));
      liveRenderers.set(conversationKey, { renderer });
      conversationNoticeTargets.set(conversationKey, async (content) => {
        if ("send" in message.channel) {
          await sendTextResponse(message.channel, content);
        }
      });

      try {
        const response = await sessionPool.respond({
          conversationKey,
          workspaceKey: getWorkspaceKeyFromMessage(message),
          sessionName: getSessionNameFromMessage(message),
          promptText: buildPromptFromMessage(message, promptText),
        });
        await renderer.finalize(response);
      } finally {
        liveRenderers.delete(conversationKey);
        conversationNoticeTargets.delete(conversationKey);
      }
      return;
    }

    if (!isProjectWorkspaceChannel(workspaceChannelId, effectiveConfig)) {
      return;
    }

    const guildTextChannel = message.channel;
    if (!("threads" in guildTextChannel)) {
      return;
    }

    const thread = await message.startThread({
      name: buildAutoThreadName(promptText),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: "picord auto-started session thread",
    });
    await thread.members.add(message.author.id).catch(() => undefined);
    await thread.sendTyping().catch(() => undefined);

    const conversationKey = `discord:guild:${message.guildId!}:thread:${thread.id}`;
    const workspaceKey = getWorkspaceKeyFromMessage(message);
    const renderer = new LiveDiscordRunRenderer(createChannelLiveMessageTarget(thread));
    liveRenderers.set(conversationKey, { renderer });
    conversationNoticeTargets.set(conversationKey, async (content) => {
      await sendTextResponse(thread, content);
    });

    try {
      const response = await sessionPool.respond({
        conversationKey,
        workspaceKey,
        sessionName: thread.name,
        promptText: buildPromptFromMessage(message, promptText),
      });
      await renderer.finalize(response);
    } finally {
      liveRenderers.delete(conversationKey);
      conversationNoticeTargets.delete(conversationKey);
    }
  }

  async function handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!config || !sessionPool) return;

    const isDm = !interaction.inGuild();
    const workspaceChannelId = getWorkspaceChannelIdFromInteraction(interaction);
    const resolvedHostChannelId = interaction.guild ? await resolveHostControlChannelId(interaction.guild) : undefined;
    const effectiveConfig = await buildEffectiveConfig(config, sessionPool, interaction.guild ?? null, resolvedHostChannelId);
    const ephemeral = shouldUseEphemeral(interaction);
    const ownerAdminCommand = isOwnerAdminCommand(interaction.commandName);

    if (!isDm && ownerAdminCommand) {
      if (!sessionPool.isOwner(interaction.user.id)) {
        await interaction.reply({
          content: "Only the configured owner can use this admin command.",
          ephemeral: true,
        });
        return;
      }

      if (!isHostControlChannel(interaction, effectiveConfig)) {
        await interaction.reply({
          content: `Use this command in #${effectiveConfig.hostChannelName}.`,
          ephemeral: true,
        });
        return;
      }
    }

    const access = isDm
      ? canAccessDm(effectiveConfig, interaction.user.id)
      : ownerAdminCommand
        ? { allowed: true }
        : canAccessGuild(effectiveConfig, {
            authorId: interaction.user.id,
            guildId: interaction.guildId!,
            channelId: workspaceChannelId,
            memberRoleIds: extractMemberRoleIds(interaction.member),
          });

    if (!access.allowed) {
      await interaction.reply({ content: access.reason ?? "Not allowed.", ephemeral });
      return;
    }

    const workspaceKey = getWorkspaceKeyFromInteraction(interaction);
    const conversationKey = getConversationKeyFromInteraction(interaction);
    const sessionName = getSessionNameFromInteraction(interaction);

    if (interaction.commandName === "status") {
      const workspaceKey = getWorkspaceKeyFromInteraction(interaction);
      await interaction.reply({
        content: buildStatusMessage(
          effectiveConfig,
          sessionPool,
          workspaceKey,
          getConversationKeyFromInteraction(interaction),
          getSessionNameFromInteraction(interaction),
          slashOnlyMode,
        ),
        ephemeral,
      });
      return;
    }

    if (interaction.commandName === "models") {
      const scope = sessionPool.getWorkspaceModelScope(workspaceKey);
      const models = scope.models.map((model) => `${model.provider}/${model.id}`).join("\n") || "No models available.";
      await interaction.reply({
        content: [`Workspace model scope: ${scope.patterns.join(", ") || "(none)"}`, models].join("\n\n"),
        ephemeral,
      });
      return;
    }

    if (interaction.commandName === "scope-models") {
      const patterns = interaction.options.getString("patterns")?.trim();
      const scope = !patterns
        ? sessionPool.getWorkspaceModelScope(workspaceKey)
        : /^(clear|reset)$/i.test(patterns)
          ? sessionPool.clearWorkspaceModelScope(workspaceKey)
          : sessionPool.setWorkspaceModelScope(workspaceKey, patterns);
      await interaction.reply({
        content: [
          `Workspace scope patterns: ${scope.patterns.join(", ") || "(none)"}`,
          `Scoped models: ${scope.models.map((model) => `${model.provider}/${model.id}`).join("\n") || "(none)"}`,
        ].join("\n\n"),
        ephemeral,
      });
      return;
    }

    if (interaction.commandName === "use-model") {
      const modelReference = interaction.options.getString("model", true).trim();
      const model = await sessionPool.setWorkspaceModel(workspaceKey, modelReference);
      await interaction.reply({
        content: `Workspace model set to ${model.provider}/${model.id}`,
        ephemeral,
      });
      return;
    }

    if (interaction.commandName === "reload") {
      if (!sessionPool.isOwner(interaction.user.id)) {
        await interaction.reply({ content: "Only the configured owner can reload picord.", ephemeral: true });
        return;
      }
      await interaction.reply({ content: "Reloading picord...", ephemeral: true });
      pi.sendUserMessage("/picord-reload", { deliverAs: "followUp" });
      return;
    }

    if (interaction.commandName === "project-create") {
      if (!sessionPool.isOwner(interaction.user.id)) {
        await interaction.reply({ content: "Only the configured owner can create project channels.", ephemeral: true });
        return;
      }
      if (!interaction.guild) {
        await interaction.reply({ content: "Use this command inside the target guild.", ephemeral: true });
        return;
      }

      const requestedName = interaction.options.getString("name", true);
      const channelName = normalizeProjectSlug(requestedName);
      const workspaceRoot = resolveManagedWorkspaceRoot(config, channelName);
      ensureDirectoryExists(workspaceRoot);

      const existingWorkspace = await findExistingManagedProjectChannel(
        interaction.guild,
        sessionPool,
        channelName,
        workspaceRoot,
      );
      if (existingWorkspace) {
        await sessionPool.addManagedWorkspace(existingWorkspace.channelId, existingWorkspace.root, channelName);
        await interaction.reply({
          content: `Project already exists: <#${existingWorkspace.channelId}> mapped to ${existingWorkspace.root}`,
          ephemeral: true,
        });
        return;
      }

      const categoryId = await ensurePicordCategory(interaction.guild);
      const createdChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: categoryId,
        topic: `picord workspace → ${workspaceRoot}`,
        reason: `picord managed project for ${channelName}`,
      });
      const managedWorkspace = await sessionPool.addManagedWorkspace(createdChannel.id, workspaceRoot, channelName);
      await createdChannel.send({
        content: [
          `🚀 **Project initialized**`,
          `📁 \`${managedWorkspace.root}\``,
          `Create a thread in this channel to start a pi session. The thread title becomes the session name.`,
          `Use /ask or skill commands inside the thread. Use /abort to stop the active run without resetting session history.`,
        ].join("\n"),
        allowedMentions: { parse: [] },
      });

      await interaction.reply({
        content: `Created <#${createdChannel.id}> mapped to ${managedWorkspace.root}`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "project-list") {
      if (!sessionPool.isOwner(interaction.user.id)) {
        await interaction.reply({ content: "Only the configured owner can list managed projects.", ephemeral: true });
        return;
      }
      const managed = sessionPool.listManagedWorkspaces();
      await interaction.reply({
        content: managed.length > 0
          ? managed.map((workspace) => `<#${workspace.channelId}> → ${workspace.root}`).join("\n")
          : "No managed project channels yet.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "access-requests") {
      if (!sessionPool.isOwner(interaction.user.id)) {
        await interaction.reply({ content: "Only the configured owner can inspect access requests.", ephemeral: true });
        return;
      }
      const pending = sessionPool.getPendingAccessRequests();
      await interaction.reply({
        content: pending.length > 0
          ? pending.map((request) => `${request.id} — ${request.summary}`).join("\n")
          : "No pending access requests.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "abort") {
      const threadRequirement = requireThreadForSessionCommand(interaction);
      if (threadRequirement) {
        await interaction.reply({ content: threadRequirement, ephemeral });
        return;
      }
      const aborted = await sessionPool.abort(conversationKey);
      await interaction.reply({
        content: aborted ? "Active run aborted. Send a new message or /ask in this thread to continue the same session." : "No active session to abort.",
        ephemeral,
      });
      return;
    }

    if (interaction.commandName === "resume") {
      const threadRequirement = requireThreadForSessionCommand(interaction);
      if (threadRequirement) {
        await interaction.reply({ content: threadRequirement, ephemeral });
        return;
      }

      const sessionReference = interaction.options.getString("session", true).trim();
      const resumed = await sessionPool.resumeSession({
        conversationKey,
        workspaceKey,
        sessionName,
        sessionReference,
      });
      await interaction.reply({
        content: `Thread bound to existing pi session ${resumed.id} (${resumed.name ?? "unnamed"}) from ${resumed.cwd}`,
        ephemeral,
      });
      return;
    }

    if (interaction.commandName === "reset") {
      const threadRequirement = requireThreadForSessionCommand(interaction);
      if (threadRequirement) {
        await interaction.reply({ content: threadRequirement, ephemeral });
        return;
      }
      const reset = await sessionPool.reset(conversationKey);
      await interaction.reply({
        content: reset ? "Session reset." : "No active session to reset.",
        ephemeral,
      });
      return;
    }

    // Delegate multi-auth commands
    if (interaction.commandName && interaction.commandName.startsWith("multi-auth")) {
      if (!multiAuthAccountManager) {
        await interaction.reply({ content: "Multi-auth credentials are not configured.", ephemeral });
        return;
      }
      await handleMultiAuthCommand(interaction, multiAuthAccountManager);
      return;
    }

    const skillCommand = isSkillCommand(interaction.commandName, sessionPool);
    if (interaction.commandName !== "ask" && !skillCommand) {
      return;
    }

    const threadRequirement = requireThreadForSessionCommand(interaction);
    if (threadRequirement) {
      await interaction.reply({ content: threadRequirement, ephemeral });
      return;
    }

    const renderer = new LiveDiscordRunRenderer(createInteractionLiveMessageTarget(interaction));
    liveRenderers.set(conversationKey, { renderer });
    conversationNoticeTargets.set(conversationKey, async (content) => {
      const channel = interaction.channel;
      if (channel && "send" in channel) {
        await sendTextResponse(channel, content);
      }
    });

    try {
      await interaction.deferReply();

      if (interaction.commandName === "ask") {
        const promptText = interaction.options.getString("prompt", true).trim();
        if (!promptText) {
          await interaction.editReply("Prompt cannot be empty.");
          return;
        }

        const response = await sessionPool.respond({
          conversationKey,
          workspaceKey,
          sessionName,
          promptText: buildPromptFromInteraction(interaction, promptText),
        });
        await renderer.finalize(response);
        return;
      }

      if (skillCommand) {
        const skillArgs = interaction.options.getString("prompt")?.trim();
        const response = await sessionPool.invokeSkill({
          conversationKey,
          workspaceKey,
          sessionName,
          skillName: skillCommand.name,
          args: skillArgs,
        });
        await renderer.finalize(response);
      }
    } finally {
      liveRenderers.delete(conversationKey);
      conversationNoticeTargets.delete(conversationKey);
    }
  }

  pi.on("session_start", async (event, ctx) => {
    if (client) return;

    config = loadRuntimeConfig(ctx.cwd);
    if (!config.isActive || !config.discordToken) {
      ctx.ui.notify("picord inactive: set PICORD_DISCORD_TOKEN to enable Discord.", "info");
      return;
    }

    const runtimeConfig = config;
    const lockResult = RuntimeLock.acquire(resolveRuntimeLockPath(runtimeConfig));
    if (!lockResult.acquired) {
      ctx.ui.notify(`picord inactive: ${lockResult.reason}`, "warning");
      return;
    }
    runtimeLock = lockResult.lock;

    const attachClientHandlers = (discordClient: Client, enableMessageContent: boolean) => {
      discordClient.on(Events.Error, (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Unknown interaction") || message.includes("Interaction has already been acknowledged")) {
          return;
        }
        ctx.ui.notify(`picord discord client error: ${message}`, "error");
      });

      discordClient.once(Events.ClientReady, async () => {
        try {
          const createdRoles = await ensureAllowedRolesExist(runtimeConfig, discordClient);
          const hostMessages = await refreshHostControlChannels(discordClient);
          await registerCommandsIfEnabled();
          if (createdRoles.length > 0) {
            ctx.ui.notify(`picord auto-created roles: ${createdRoles.join(", ")}`, "info");
          }
          for (const hostMessage of hostMessages) {
            ctx.ui.notify(
              hostMessage,
              hostMessage.includes("unresolved") ? "warning" : "info",
            );
          }
        } catch (error) {
          ctx.ui.notify(`picord command registration failed: ${String(error)}`, "error");
        }

        const modeLabel = enableMessageContent ? "full mode" : "slash-only mode";
        ctx.ui.notify(`picord connected as ${discordClient.user?.tag ?? "Discord bot"} (${modeLabel})`, "info");
        if ((event as { reason?: string }).reason === "reload") {
          ctx.ui.notify("picord reload complete.", "info");
        }
      });

      if (enableMessageContent) {
        discordClient.on(Events.MessageCreate, async (message) => {
          try {
            await handleDiscordMessage(message);
          } catch (error) {
            const channel = message.channel;
            if (channel && "send" in channel) {
              await sendTextResponse(channel, `picord error: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        });
      }

      discordClient.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        try {
          await handleInteraction(interaction);
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          if (
            messageText.includes("Unknown interaction")
            || messageText.includes("Interaction has already been acknowledged")
          ) {
            return;
          }

          ctx.ui.notify(`picord interaction error: ${messageText}`, "error");
        }
      });
    };

    const createDiscordClient = (enableMessageContent: boolean) => new Client({
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

    try {
      sessionPool = new PiSessionPool(runtimeConfig, notifyAccessRequest, notifyConversation);
      await sessionPool.initialize();

      // Initialize multi-auth: wrap API providers with credential rotation
      const stateDir = path.dirname(runtimeConfig.statePath);
      initMultiAuthConfig(runtimeConfig.statePath, stateDir);

      if (config.multiAuth?.enabled !== false) {
        const { buildMultiAuthExtensionConfig } = await import("./multi-auth/picord-config-adapter.js");
        const maConfig = buildMultiAuthExtensionConfig(config.multiAuth ?? {});

        multiAuthAccountManager = new AccountManager(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maConfig,
        );

        const keyDistributor = multiAuthAccountManager.getKeyDistributor();
        registerGlobalKeyDistributor(keyDistributor);

        await registerMultiAuthProviders(pi, multiAuthAccountManager, {
          excludeProviders: maConfig.excludeProviders,
          streamTimeouts: maConfig.streamTimeouts,
        }).catch((err) => {
          ctx.ui.notify(`multi-auth provider registration warning: ${err.message}`, "warning");
        });

        // Warm up: auto-activate preferred credentials
        await multiAuthAccountManager.ensureInitialized();
        await multiAuthAccountManager.autoActivatePreferredCredentials({ avoidUsageApi: true }).catch((err) => {
          ctx.ui.notify(`multi-auth warmup warning: ${err.message}`, "warning");
        });
        if (maConfig.debug) {
          multiAuthDebugLogger.initialize(true);
        }

        ctx.ui.notify("multi-auth credentials loaded.", "info");
      }

      if (!isEncryptionAvailable()) {
        ctx.ui.notify("⚠️ PICORD_ENCRYPTION_KEY not set. Credentials stored in plaintext.", "warning");
      }

      client = createDiscordClient(true);
      attachClientHandlers(client, true);

      try {
        await client.login(config.discordToken);
        slashOnlyMode = false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("Used disallowed intents")) {
          throw error;
        }

        ctx.ui.notify("Discord Message Content intent is unavailable; falling back to slash-only mode.", "warning");
        try {
          await client.destroy();
        } catch {}

        slashOnlyMode = true;
        client = createDiscordClient(false);
        attachClientHandlers(client, false);
        await client.login(config.discordToken);
      }
    } catch (error) {
      if (client) {
        try {
          await client.destroy();
        } catch {}
        client = undefined;
      }
      if (sessionPool) {
        await sessionPool.dispose();
        sessionPool = undefined;
      }
      hostControlChannels.clear();
      conversationNoticeTargets.clear();
      if (multiAuthAccountManager) {
        unregisterGlobalKeyDistributor(multiAuthAccountManager.getKeyDistributor());
        multiAuthAccountManager.shutdown();
        multiAuthAccountManager = undefined;
      }
      if (runtimeLock) {
        runtimeLock.release();
        runtimeLock = undefined;
      }
      config = undefined;
      throw error;
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (client) {
      await client.destroy();
      client = undefined;
    }

    if (sessionPool) {
      await sessionPool.dispose();
      sessionPool = undefined;
    }

    liveRenderers.clear();
    conversationNoticeTargets.clear();
    if (multiAuthAccountManager) {
      unregisterGlobalKeyDistributor(multiAuthAccountManager.getKeyDistributor());
      multiAuthAccountManager.shutdown();
      multiAuthAccountManager = undefined;
    }
    hostControlChannels.clear();
    if (runtimeLock) {
      runtimeLock.release();
      runtimeLock = undefined;
    }
    config = undefined;
    ctx.ui.notify("picord disconnected.", "info");
  });
}
