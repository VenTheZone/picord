import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type TextChannel,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { canAccessDm, canAccessGuild } from "../auth.js";
import { isEncryptionAvailable } from "../crypto/encryption.js";

import {
  LiveDiscordRunRenderer,
  createInteractionLiveMessageTarget,
} from "../live-discord-renderer.js";
import {
  buildEffectiveAccessConfig,
  extractMemberRoleIds,
  getWorkspaceChannelIdFromInteraction,
} from "./access-control.js";
import { isGitWorkspace, reviewGitDiff, shareGitDiff } from "../critique.js";
import {
  buildPromptFromInteraction,
  replyToInteraction,
} from "./message-helpers.js";
import { handleMultiAuthCommand } from "./multi-auth-commands.js";
import type { AccountManager } from "./multi-auth-integration.js";
import type { DiscordPortRuntime } from "./runtime.js";

import type { SupportedProviderId } from "../multi-auth/index-export.js";

const SCOPE_MODELS_APPLY_PREFIX = "scope-models:apply:";
const SCOPE_MODELS_CLEAR = "scope-models:clear";
const ADD_PROJECT_SELECT = "add-project:select";
const LOGIN_PROVIDER_SELECT = "login:provider";
const LOGIN_OAUTH_COMPLETE_PREFIX = "login:oauth:complete:";
const LOGIN_OAUTH_PROMPT_PREFIX = "login:oauth:prompt:";
const LOGIN_API_KEY_MODAL_PREFIX = "login:api-key:";
const LOGIN_OAUTH_MODAL_PREFIX = "login:oauth:modal:";
const LOGIN_OAUTH_CANCEL_PREFIX = "login:oauth:cancel:";
const SESSION_SELECT = "session:select";
const ACCESS_BUTTON_PREFIX = "access:";
const OUTSIDE_WORKSPACE_PROJECT_SELECT = "outside-workspace:project-select";
const OUTSIDE_WORKSPACE_BUTTON_PREFIX = "outside-workspace:toggle:";

function truncateEmbedFieldValue(value: string, maxLength = 1024): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

function truncateToLimit(str: string, limit: number): string {
  return str.length <= limit ? str : `${str.slice(0, limit - 1)}…`;
}

export function extractDeviceCodeFromInstructions(
  instructions?: string,
): string | undefined {
  if (!instructions) return undefined;

  const patterns = [
    /enter\s+code\s*[:-]?\s*([A-Z0-9-]{4,})/i,
    /one-time\s+code\s*[:-]?\s*([A-Z0-9-]{4,})/i,
    /device\s+code\s*[:-]?\s*([A-Z0-9-]{4,})/i,
    /code\s*[:-]\s*([A-Z0-9-]{4,})/i,
  ];

  for (const pattern of patterns) {
    const match = instructions.match(pattern);
    const code = match?.[1]?.trim();
    if (code) return code;
  }

  return undefined;
}

export function buildOAuthLoginEmbed({
  providerName,
  verificationUrl,
  instructions,
}: {
  providerName: string;
  verificationUrl: string;
  instructions?: string;
}): EmbedBuilder {
  const deviceCode = extractDeviceCodeFromInstructions(instructions);
  const isDeviceCodeFlow = !!deviceCode;

  const embed = new EmbedBuilder()
    .setTitle(`${providerName} Login`)
    .setColor(isDeviceCodeFlow ? 0x5865f2 : 0xf59e0b)
    .setDescription(
      isDeviceCodeFlow
        ? `**${providerName}** uses device code login.\n\nEnter the code shown below at the verification page, then click **I've completed the step** when done.`
        : `**${providerName}** uses browser callback login.\n\nOpen the verification page, complete the browser steps, then click **Complete login** and paste the redirected URL.`,
    )
    .addFields({
      name: "Verification page",
      value: `[Open verification page](${verificationUrl})`,
      inline: false,
    });

  if (isDeviceCodeFlow) {
    embed.addFields({
      name: "Device code",
      value: `\`${deviceCode}\``,
      inline: false,
    });
  }

  embed.addFields({
    name: "Instructions",
    value: instructions || "Follow the steps on the verification page.",
    inline: false,
  });

  return embed;
}

// --- Usage command helpers ---

async function _getUsageOverview(
  accountManager: AccountManager,
): Promise<Record<string, string>> {
  const providers = await accountManager.getSupportedProviders();
  const usageMap: Record<string, string> = {};

  for (const provider of providers) {
    try {
      const status = await accountManager.getProviderStatus(provider);
      for (const cred of status.credentials) {
        const snapshot = cred.usageSnapshot;
        if (!snapshot) continue;

        const lines: string[] = [];

        if (snapshot.primary) {
          lines.push(
            `• Primary: ${snapshot.primary.usedPercent.toFixed(1)}% used`,
          );
          if (snapshot.primary.resetsAt) {
            lines.push(
              `  Resets: ${new Date(snapshot.primary.resetsAt * 1000).toLocaleString()}`,
            );
          }
        }
        if (snapshot.secondary) {
          lines.push(
            `• Secondary: ${snapshot.secondary.usedPercent.toFixed(1)}% used`,
          );
        }
        if (snapshot.copilotQuota) {
          if (snapshot.copilotQuota.chat) {
            const chatRemain = snapshot.copilotQuota.chat.unlimited
              ? "∞"
              : (snapshot.copilotQuota.chat.remaining ?? "N/A");
            lines.push(
              `• Copilot Chat: ${chatRemain} remaining${snapshot.copilotQuota.chat.unlimited ? " (unlimited)" : ""}`,
            );
          }
          if (snapshot.copilotQuota.completions) {
            const compRemain = snapshot.copilotQuota.completions.unlimited
              ? "∞"
              : (snapshot.copilotQuota.completions.remaining ?? "N/A");
            lines.push(`• Copilot Completions: ${compRemain} remaining`);
          }
        }

        lines.push(`• Requests: ${cred.usageCount}`);
        if (cred.quotaErrorCount > 0)
          lines.push(`• Quota errors: ${cred.quotaErrorCount}`);
        if (cred.transientErrorCount)
          lines.push(`• Transient errors: ${cred.transientErrorCount}`);
        if (cred.expiresAt)
          lines.push(`• Expires: ${new Date(cred.expiresAt).toLocaleString()}`);

        if (lines.length > 0) {
          usageMap[`${provider} / ${cred.friendlyName ?? cred.credentialId}`] =
            lines.join("\n");
        }
      }
    } catch {
      usageMap[provider] = "Unable to fetch usage data.";
    }
  }

  return usageMap;
}

function _buildUsageEmbed(usageMap: Record<string, string>): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Credential Usage / Quota")
    .setColor(0x5865f2)
    .setTimestamp();

  for (const [key, value] of Object.entries(usageMap)) {
    embed.addFields({
      name: key,
      value: truncateEmbedFieldValue(value),
      inline: false,
    });
  }

  return embed;
}

function requireGuild(
  interaction: ChatInputCommandInteraction,
): asserts interaction is ChatInputCommandInteraction & { guildId: string } {
  if (!interaction.guildId) {
    throw new Error("This command can only be used in a guild.");
  }
}

function requireThread(interaction: ChatInputCommandInteraction) {
  const channel = interaction.channel;
  if (
    !channel ||
    (channel.type !== ChannelType.PublicThread &&
      channel.type !== ChannelType.PrivateThread)
  ) {
    throw new Error(
      "Use this command inside a Discord thread. Project channel = workspace, thread = pi session.",
    );
  }
  return channel;
}

function requireSessionThreadIfGuild(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    return undefined;
  }
  return requireThread(interaction);
}

function requireOwner(
  interaction: ChatInputCommandInteraction,
  runtime: DiscordPortRuntime,
): void {
  if (!runtime.adapter.isOwner(interaction.user.id)) {
    throw new Error("Only the configured owner can use this command.");
  }
}

function requireOwnerOrAdmin(
  interaction: ChatInputCommandInteraction,
  runtime: DiscordPortRuntime,
): void {
  if (runtime.adapter.isOwner(interaction.user.id)) {
    return;
  }

  if (
    interaction.guildId &&
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    return;
  }

  throw new Error(
    "Only the configured owner or a Discord administrator can use this command.",
  );
}

function isHostControlChannel(
  interaction: ChatInputCommandInteraction,
  runtime: DiscordPortRuntime,
): boolean {
  if (runtime.adapter.config.hostChannelId) {
    return interaction.channelId === runtime.adapter.config.hostChannelId;
  }

  const channel = interaction.channel;
  if (!channel || channel.isThread()) {
    return false;
  }

  return "name" in channel && typeof channel.name === "string"
    ? channel.name.toLowerCase() === runtime.adapter.config.hostChannelName
    : false;
}

function requireHostChannel(
  interaction: ChatInputCommandInteraction,
  runtime: DiscordPortRuntime,
): void {
  if (!isHostControlChannel(interaction, runtime)) {
    throw new Error(
      `Use this command in #${runtime.adapter.config.hostChannelName}.`,
    );
  }
}

function isOwnerAdminCommand(commandName: string): boolean {
  return [
    "reload",
    "restart",
    "project-create",
    "add-project",
    "add-project-path",
    "project-list",
    "project-list-available",
    "session",
    "access-requests",
    "outside-workspace-access",
  ].includes(commandName);
}

export function ownerAdminCommandRequiresHostChannel(
  commandName: string,
  addProjectMode?: string,
): boolean {
  if (["outside-workspace-access", "reload", "restart"].includes(commandName)) {
    return false;
  }

  return !(
    commandName === "add-project-path" && addProjectMode === "current-channel"
  );
}

function findSkillCommand(commandName: string, runtime: DiscordPortRuntime) {
  return runtime.adapter
    .listSkillSummaries()
    .find((skill) => skill.name === commandName);
}

function getThreadFromInteractionChannel(
  channel: Interaction["channel"],
): ChatInputCommandInteraction["channel"] | undefined {
  if (
    !channel ||
    (channel.type !== ChannelType.PublicThread &&
      channel.type !== ChannelType.PrivateThread)
  ) {
    return undefined;
  }
  return channel as ChatInputCommandInteraction["channel"];
}

function getWorkspaceKey(
  runtime: DiscordPortRuntime,
  interaction: Interaction & {
    guildId?: string | null;
    channelId: string;
    channel?: Interaction["channel"] | null;
  },
) {
  return runtime.getWorkspaceKeyForLocation({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    thread: getThreadFromInteractionChannel(interaction.channel) as never,
  });
}

function buildScopeModelsPrompt({
  provider,
  totalMatches,
  truncated,
  query,
}: {
  provider: string;
  totalMatches: number;
  truncated: boolean;
  query: string;
}) {
  return [
    `Select scoped models for ${provider}.`,
    query ? `Filter: ${query}` : undefined,
    truncated
      ? `Showing the first 25 of ${totalMatches} matches. Narrow the query if needed.`
      : `Matches: ${totalMatches}`,
    "This replaces the workspace scope. Use /use-model after this to choose the active model.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatSessionModified(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function buildGroupedSessionLines(
  sessions: Array<{
    projectName: string;
    name?: string;
    messageCount: number;
    modified: Date;
    cwd: string;
  }>,
): string[] {
  const sorted = [...sessions].sort((left, right) => {
    const projectCompare = left.projectName.localeCompare(right.projectName);
    if (projectCompare !== 0) return projectCompare;
    return right.modified.getTime() - left.modified.getTime();
  });

  const lines: string[] = ["Choose a session to restore.", ""];
  let currentProject: string | undefined;
  let projectSessionIndex = 0;

  for (const session of sorted) {
    if (session.projectName !== currentProject) {
      currentProject = session.projectName;
      projectSessionIndex = 0;
      if (lines[lines.length - 1] !== "") {
        lines.push("");
      }
      lines.push(`**${session.projectName}**`);
    }

    projectSessionIndex += 1;
    const title =
      session.name?.trim() ||
      `${session.projectName} session ${projectSessionIndex}`;
    lines.push(`- ${title}`);
    lines.push(
      `  ${session.messageCount} msg · ${formatSessionModified(session.modified)}`,
    );
    lines.push(`  ${session.cwd}`);
  }

  return lines;
}

async function handleLoginCommand(
  interaction: ChatInputCommandInteraction,
  runtime: DiscordPortRuntime,
): Promise<void> {
  const providers = runtime.adapter.listLoginProviders();
  const oauthProviders = providers.filter((p) => p.method === "oauth");

  if (oauthProviders.length === 0) {
    await interaction.reply({
      content:
        "No OAuth providers available. Use `/login provider: <name> key: <key>` to set an API key directly.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // OAuth flows (select menu, buttons, modals) all require the host control channel
  // for security. Guide the user there early instead of failing mid-flow.
  if (interaction.guildId && !isHostControlChannel(interaction, runtime)) {
    const hostChannelId = runtime.adapter.config.hostChannelId;
    const hostChannelName = runtime.adapter.config.hostChannelName;
    const hint = hostChannelId
      ? `Use this command in <#${hostChannelId}>.`
      : `Use this command in #${hostChannelName}.`;
    await interaction.reply({
      content: `OAuth login requires the host control channel. ${hint}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(LOGIN_PROVIDER_SELECT)
    .setPlaceholder("Choose an OAuth provider to log in")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      ...oauthProviders.slice(0, 25).map((provider) => ({
        label: provider.name.slice(0, 100),
        value: provider.id,
        description: provider.hasStoredAuth
          ? "Re-authenticate or update subscription"
          : "Start OAuth login",
      })),
    );

  await interaction.reply({
    content:
      "**OAuth Login** - Select a provider to start authentication:\n\nFor API keys, use `/login provider: <name> key: <key>`",
    flags: MessageFlags.Ephemeral,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    ],
  });
}

export function buildAccessRequestLines(request: {
  id: string;
  summary: string;
}): string[] {
  return [
    "Permission request",
    `Request ID: ${request.id}`,
    `Requested action: ${request.summary}`,
    "Use the buttons below to approve or deny.",
  ];
}

function buildOutsideWorkspaceToggleLines(
  project: { channelId: string; name?: string },
  enabled: boolean,
): string[] {
  return [
    `Project: <#${project.channelId}>${project.name ? ` (${project.name})` : ""}`,
    `Outside-workspace access: ${enabled ? "ENABLED" : "disabled"}`,
    enabled
      ? "Blocked sensitive paths still remain protected."
      : "Enable only if you want AI to access files outside this project workspace.",
  ];
}

function resolveProjectDirectory(baseDir: string, inputPath: string): string {
  const trimmed = inputPath.trim();
  const expanded =
    trimmed === "~"
      ? (process.env.HOME ?? trimmed)
      : trimmed.startsWith("~/")
        ? path.join(process.env.HOME ?? "", trimmed.slice(2))
        : trimmed;
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function requireBindableGuildTextChannel(
  interaction: ChatInputCommandInteraction,
  runtime: DiscordPortRuntime,
): TextChannel {
  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error("Current-channel mode only works in a guild text channel.");
  }
  if (isHostControlChannel(interaction, runtime)) {
    throw new Error(
      "The host control channel cannot be rebound as a project channel.",
    );
  }
  return channel;
}

function getCritiqueWorkspaceRoot(
  interaction: ChatInputCommandInteraction,
  runtime: DiscordPortRuntime,
): string {
  if (!interaction.guildId) {
    return runtime.adapter.getWorkspaceInfo(
      getWorkspaceKey(runtime, interaction),
    ).root;
  }

  if (interaction.channel?.isThread()) {
    return runtime.adapter.getWorkspaceInfo(
      getWorkspaceKey(runtime, interaction),
    ).root;
  }

  if (runtime.adapter.isManagedProjectChannel(interaction.channelId)) {
    return runtime.adapter.getWorkspaceInfo(
      getWorkspaceKey(runtime, interaction),
    ).root;
  }

  throw new Error(
    "Use this command in a managed project channel, a session thread, or a DM.",
  );
}

async function checkInteractionAccess(
  interaction: Interaction & {
    guildId?: string | null;
    guild?: Interaction["guild"] | null;
    user: { id: string };
    channelId: string;
    member?: unknown;
  },
  runtime: DiscordPortRuntime,
) {
  const effectiveConfig = interaction.guild
    ? await buildEffectiveAccessConfig(
        runtime.adapter.config,
        runtime.adapter,
        interaction.guild,
      )
    : runtime.adapter.config;

  return !interaction.guildId
    ? canAccessDm(effectiveConfig, interaction.user.id)
    : canAccessGuild(effectiveConfig, {
        authorId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: getWorkspaceChannelIdFromInteraction(interaction),
        memberRoleIds: extractMemberRoleIds(interaction.member),
      });
}

export function registerDiscordPortInteractionHandler({
  client,
  runtime,
  _onReload,
  multiAuthAccountManager,
}: {
  client: Client;
  runtime: DiscordPortRuntime;
  _onReload?: () => void;
  multiAuthAccountManager?: AccountManager;
}) {
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isAutocomplete()) {
      try {
        const access = await checkInteractionAccess(interaction, runtime);
        if (!access.allowed) {
          await interaction.respond([]);
          return;
        }

        const focused = interaction.options.getFocused(true);
        if (
          interaction.commandName === "scope-models" &&
          focused.name === "provider"
        ) {
          await interaction.respond(
            runtime.findProviderChoices(String(focused.value ?? "")),
          );
          return;
        }

        if (
          interaction.commandName === "resume" ||
          interaction.commandName === "use-model" ||
          interaction.commandName === "model"
        ) {
          const workspaceKey = getWorkspaceKey(runtime, interaction);
          const query = String(focused.value ?? "");
          const choices =
            interaction.commandName === "resume"
              ? await runtime.findResumeChoices(workspaceKey, query)
              : runtime.findModelChoices(workspaceKey, query);
          await interaction.respond(choices);
          return;
        }

        if (
          interaction.commandName === "multi-auth" &&
          focused.name === "provider"
        ) {
          if (!multiAuthAccountManager) {
            await interaction.respond([]);
            return;
          }
          try {
            const providers =
              await multiAuthAccountManager.getSupportedProviders();
            await interaction.respond(
              providers.map((p: SupportedProviderId) => ({
                name: p,
                value: p,
              })),
            );
          } catch {
            await interaction.respond([]);
          }
          return;
        }

        if (
          interaction.commandName === "login" &&
          focused.name === "provider"
        ) {
          const query = String(focused.value ?? "").toLowerCase();
          const allProviders = runtime.adapter.listLoginProviders();

          const oauthProviders = allProviders
            .filter((p) => p.method === "oauth")
            .filter(
              (p) =>
                query === "" ||
                p.name.toLowerCase().includes(query) ||
                p.id.toLowerCase().includes(query),
            );

          const apiKeyProviders = allProviders
            .filter((p) => p.method === "api-key")
            .filter(
              (p) =>
                query === "" ||
                p.name.toLowerCase().includes(query) ||
                p.id.toLowerCase().includes(query),
            );

          const choices = [
            ...oauthProviders
              .slice(0, 10)
              .map((p) => ({ name: `${p.name} (OAuth)`, value: p.id })),
            ...apiKeyProviders
              .slice(0, 10)
              .map((p) => ({ name: `${p.name} (API key)`, value: p.id })),
          ].slice(0, 25);

          await interaction.respond(choices);
          return;
        }

        await interaction.respond([]);
      } catch {
        await interaction.respond([]).catch(() => undefined);
      }
      return;
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === SESSION_SELECT
    ) {
      try {
        requireOwner(interaction as never, runtime);
        requireHostChannel(interaction as never, runtime);
        if (!interaction.guild)
          throw new Error("This action can only be used in a guild.");

        const sessionId = interaction.values[0]?.trim();
        if (!sessionId) throw new Error("No session was selected.");
        const session = (await runtime.adapter.listAllSessions(100)).find(
          (entry) => entry.id === sessionId,
        );
        if (!session) throw new Error("Selected session no longer exists.");

        const created = await runtime.addExistingProjectChannel({
          guild: interaction.guild,
          projectDirectory: session.cwd,
          projectName: session.projectName,
          requestedBy: interaction.user,
        });
        const channel = await interaction.guild.channels.fetch(
          created.textChannelId,
        );
        if (!channel || channel.type !== ChannelType.GuildText) {
          throw new Error("Project channel could not be loaded.");
        }
        const thread = await channel.threads.create({
          name: (
            session.name?.trim() || `${session.projectName} session`
          ).slice(0, 100),
          autoArchiveDuration: 1440,
          reason: `picord resumed session ${session.id}`,
        });
        const binding = runtime.bindThread(thread);
        await runtime.adapter.resumeSession({
          conversationKey: binding.conversationKey,
          workspaceKey: binding.workspaceKey,
          sessionName: binding.sessionName,
          sessionReference: session.id,
        });

        await interaction.update({
          content: `Resumed session ${session.id} in <#${created.textChannelId}> → thread <#${thread.id}> (${session.cwd})`,
          components: [],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction
            .followUp({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        } else {
          await interaction
            .reply({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        }
      }
      return;
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === LOGIN_PROVIDER_SELECT
    ) {
      try {
        requireOwner(interaction as never, runtime);
        requireHostChannel(interaction as never, runtime);

        const providerId = interaction.values[0]?.trim();
        if (!providerId) {
          throw new Error("No provider was selected.");
        }

        const provider = runtime.adapter
          .listLoginProviders()
          .find((entry) => entry.id === providerId);
        if (!provider) {
          throw new Error(`Unknown provider: ${providerId}`);
        }

        if (provider.method === "oauth") {
          if (provider.supportsDiscordFlow === false) {
            await interaction.update({
              content: [
                `**${provider.name}** cannot finish OAuth inside Discord yet.`,
                provider.discordFlowReason ??
                  "Use pi locally for this provider's login flow.",
              ].join("\n"),
              embeds: [],
              components: [],
            });
            return;
          }

          const started = await runtime.adapter.startProviderOAuthLogin(
            provider.id,
            interaction.user.id,
          );

          const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setStyle(ButtonStyle.Link)
              .setLabel("Open verification page")
              .setURL(started.url),
            new ButtonBuilder()
              .setCustomId(`${LOGIN_OAUTH_COMPLETE_PREFIX}${provider.id}`)
              .setLabel("Complete login")
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`${LOGIN_OAUTH_CANCEL_PREFIX}${provider.id}`)
              .setLabel("Cancel login")
              .setStyle(ButtonStyle.Danger),
          );
          const components: Array<ActionRowBuilder<ButtonBuilder>> = [
            buttonRow,
          ];
          if (started.pendingPrompt) {
            components.push(
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId(`${LOGIN_OAUTH_PROMPT_PREFIX}${provider.id}`)
                  .setLabel("Answer provider prompt")
                  .setStyle(ButtonStyle.Secondary),
              ),
            );
          }

          await interaction.update({
            content: `${provider.name} login ready. Use the buttons below.${started.pendingPrompt ? "\nThis provider needs one extra answer before login can finish." : ""}${provider.discordFlowReason ? `\n${provider.discordFlowReason}` : ""}`,
            embeds: [
              buildOAuthLoginEmbed({
                providerName: provider.name,
                verificationUrl: started.url,
                instructions: started.instructions,
              }),
            ],
            components,
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId(`${LOGIN_API_KEY_MODAL_PREFIX}${provider.id}`)
          .setTitle(truncateToLimit(`Set ${provider.name} API key`, 45))
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("apiKey")
                .setLabel("API key")
                .setStyle(TextInputStyle.Paragraph)
                .setMinLength(1)
                .setMaxLength(4000)
                .setRequired(true),
            ),
          );
        await interaction.showModal(modal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction
            .followUp({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        } else {
          await interaction
            .reply({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        }
      }
      return;
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === OUTSIDE_WORKSPACE_PROJECT_SELECT
    ) {
      try {
        requireOwner(interaction as never, runtime);
        requireHostChannel(interaction as never, runtime);

        const channelId = interaction.values[0]?.trim();
        if (!channelId) throw new Error("No project was selected.");
        const project = runtime.adapter
          .listManagedProjects()
          .find((entry) => entry.channelId === channelId);
        if (!project) throw new Error("Selected project no longer exists.");

        const workspaceKey = runtime.buildWorkspaceKey(
          interaction.guildId!,
          channelId,
        );
        const enabled = runtime.adapter.isOutsideWorkspaceAllowed(workspaceKey);
        const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${OUTSIDE_WORKSPACE_BUTTON_PREFIX}allow:${channelId}`)
            .setLabel("Enable")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`${OUTSIDE_WORKSPACE_BUTTON_PREFIX}deny:${channelId}`)
            .setLabel("Disable")
            .setStyle(ButtonStyle.Secondary),
        );

        await interaction.update({
          content: buildOutsideWorkspaceToggleLines(project, enabled).join(
            "\n",
          ),
          components: [buttons],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction
            .followUp({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        } else {
          await interaction
            .reply({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        }
      }
      return;
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === ADD_PROJECT_SELECT
    ) {
      try {
        requireOwner(interaction as never, runtime);
        requireHostChannel(interaction as never, runtime);

        if (!interaction.guild) {
          throw new Error("This action can only be used in a guild.");
        }

        const selectedName = interaction.values[0]?.trim();
        if (!selectedName) {
          throw new Error("No project was selected.");
        }

        const project = runtime
          .listAvailableProjects()
          .find((entry) => entry.name === selectedName);
        if (!project) {
          throw new Error(
            `Project not found under ${runtime.getProjectsDir()}: ${selectedName}`,
          );
        }

        const created = await runtime.addExistingProjectChannel({
          guild: interaction.guild,
          projectDirectory: project.root,
          projectName: project.name,
          requestedBy: interaction.user,
        });

        await interaction.update({
          content: [
            created.created
              ? `Created <#${created.textChannelId}> mapped to ${project.root}`
              : `Reusing <#${created.textChannelId}> mapped to ${project.root}`,
            "Send a message in that project channel to start a thread-backed session.",
          ].join("\n"),
          components: [],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction
            .followUp({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        } else {
          await interaction
            .reply({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        }
      }
      return;
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith(SCOPE_MODELS_APPLY_PREFIX)
    ) {
      try {
        const access = await checkInteractionAccess(interaction, runtime);
        if (!access.allowed) {
          await interaction.reply({
            content: access.reason ?? "Not allowed.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const workspaceKey = getWorkspaceKey(runtime, interaction);
        const scope = runtime.adapter.setWorkspaceModelScope(
          workspaceKey,
          interaction.values.join(" "),
        );
        await interaction.update({
          content: `Workspace model scope updated to ${scope.models.length} model${scope.models.length === 1 ? "" : "s"}. Use /use-model to pick the active model.`,
          components: [],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction
            .followUp({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        } else {
          await interaction
            .reply({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        }
      }
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith(ACCESS_BUTTON_PREFIX)
    ) {
      try {
        requireOwner(interaction as never, runtime);

        const [, mode, requestId] = interaction.customId.split(":");
        if (!requestId || !mode || !["once", "always", "deny"].includes(mode)) {
          throw new Error("Invalid access request action.");
        }

        const request = runtime.adapter.resolveAccessRequest(
          requestId,
          mode as "once" | "always" | "deny",
        );
        await interaction.update({
          content: request
            ? `Resolved ${requestId}: ${mode}.`
            : `No pending access request with id ${requestId}.`,
          components: [],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction
            .followUp({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        } else {
          await interaction
            .reply({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        }
      }
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith(OUTSIDE_WORKSPACE_BUTTON_PREFIX)
    ) {
      try {
        requireOwner(interaction as never, runtime);
        const [, , mode, channelId] = interaction.customId.split(":");
        if (!channelId || !mode || !["allow", "deny"].includes(mode)) {
          throw new Error("Invalid outside-workspace action.");
        }

        const workspaceKey = runtime.buildWorkspaceKey(
          interaction.guildId!,
          channelId,
        );
        const allowed = mode === "allow";
        runtime.adapter.setOutsideWorkspaceAllowed(workspaceKey, allowed);
        const project = runtime.adapter
          .listManagedProjects()
          .find((entry) => entry.channelId === channelId) ?? { channelId };

        await interaction.update({
          content: buildOutsideWorkspaceToggleLines(project, allowed).join(
            "\n",
          ),
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(
                  `${OUTSIDE_WORKSPACE_BUTTON_PREFIX}allow:${channelId}`,
                )
                .setLabel("Enable")
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(
                  `${OUTSIDE_WORKSPACE_BUTTON_PREFIX}deny:${channelId}`,
                )
                .setLabel("Disable")
                .setStyle(ButtonStyle.Secondary),
            ),
          ],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction
            .followUp({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        } else {
          await interaction
            .reply({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        }
      }
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith(LOGIN_OAUTH_PROMPT_PREFIX)
    ) {
      try {
        requireOwner(interaction as never, runtime);
        requireHostChannel(interaction as never, runtime);
        const providerId = interaction.customId.slice(
          LOGIN_OAUTH_PROMPT_PREFIX.length,
        );
        const provider = runtime.adapter
          .listLoginProviders()
          .find((entry) => entry.id === providerId);
        const prompt = runtime.adapter.getPendingOAuthPrompt(
          providerId,
          interaction.user.id,
        );
        if (!prompt) {
          throw new Error(
            "This login is not currently waiting for a provider prompt.",
          );
        }
        const modal = new ModalBuilder()
          .setCustomId(`${LOGIN_OAUTH_MODAL_PREFIX}${providerId}:prompt`)
          .setTitle(
            truncateToLimit(
              `Answer ${provider?.name ?? providerId} prompt`,
              45,
            ),
          )
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("prompt")
                .setLabel(prompt.message.slice(0, 45) || "Prompt")
                .setPlaceholder(prompt.placeholder?.slice(0, 100) ?? "")
                .setStyle(TextInputStyle.Short)
                .setMinLength(1)
                .setMaxLength(1024)
                .setRequired(!prompt.allowEmpty),
            ),
          );
        await interaction.showModal(modal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction
            .followUp({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        } else {
          await interaction
            .reply({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        }
      }
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith(LOGIN_OAUTH_COMPLETE_PREFIX)
    ) {
      try {
        requireOwner(interaction as never, runtime);
        requireHostChannel(interaction as never, runtime);
        const providerId = interaction.customId.slice(
          LOGIN_OAUTH_COMPLETE_PREFIX.length,
        );
        const provider = runtime.adapter
          .listLoginProviders()
          .find((entry) => entry.id === providerId);
        const modal = new ModalBuilder()
          .setCustomId(`${LOGIN_OAUTH_MODAL_PREFIX}${providerId}`)
          .setTitle(
            truncateToLimit(
              `Complete ${provider?.name ?? providerId} login`,
              45,
            ),
          )
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("code")
                .setLabel("Paste the final local-browser redirect URL")
                .setPlaceholder(
                  "http://localhost:1455/auth/callback?code=...&state=... or just the code",
                )
                .setStyle(TextInputStyle.Paragraph)
                .setMinLength(1)
                .setMaxLength(4000)
                .setRequired(true),
            ),
          );
        await interaction.showModal(modal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction
            .followUp({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        } else {
          await interaction
            .reply({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        }
      }
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith(LOGIN_OAUTH_CANCEL_PREFIX)
    ) {
      try {
        requireOwner(interaction as never, runtime);
        const providerId = interaction.customId.slice(
          LOGIN_OAUTH_CANCEL_PREFIX.length,
        );
        const provider = runtime.adapter
          .listLoginProviders()
          .find((entry) => entry.id === providerId);
        runtime.adapter.cancelProviderOAuthLogin(interaction.user.id);
        await interaction.update({
          content: `${provider?.name ?? providerId} login cancelled. Ready for a fresh attempt with /login.`,
          embeds: [],
          components: [],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction
            .followUp({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        } else {
          await interaction
            .reply({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        }
      }
      return;
    }

    if (interaction.isButton() && interaction.customId === SCOPE_MODELS_CLEAR) {
      try {
        const access = await checkInteractionAccess(interaction, runtime);
        if (!access.allowed) {
          await interaction.reply({
            content: access.reason ?? "Not allowed.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const workspaceKey = getWorkspaceKey(runtime, interaction);
        runtime.adapter.clearWorkspaceModelScope(workspaceKey);
        await interaction.update({
          content:
            "Workspace model scope cleared. /use-model will show all configured models again.",
          components: [],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction
            .followUp({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        } else {
          await interaction
            .reply({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        }
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      try {
        requireOwner(interaction as never, runtime);
        requireHostChannel(interaction as never, runtime);

        if (interaction.customId.startsWith(LOGIN_API_KEY_MODAL_PREFIX)) {
          const providerId = interaction.customId.slice(
            LOGIN_API_KEY_MODAL_PREFIX.length,
          );
          const apiKey = interaction.fields.getTextInputValue("apiKey");
          runtime.adapter.setProviderApiKey(providerId, apiKey);
          const messages = [`✅ Stored API key for **${providerId}**.`];
          if (!isEncryptionAvailable()) {
            messages.push(
              "⚠️ **Credentials stored in plaintext.** Set `PICORD_ENCRYPTION_KEY` env var to encrypt.",
            );
          }
          if (multiAuthAccountManager) {
            try {
              await multiAuthAccountManager.addApiKeyCredential(
                providerId as SupportedProviderId,
                apiKey,
              );
              messages.push("🔄 Added to multi-auth rotation.");
              const status = await multiAuthAccountManager.getProviderStatus(
                providerId as SupportedProviderId,
              );
              if (status.credentials.length > 0) {
                messages.push(
                  `📊 **${status.credentials.length}** credential${status.credentials.length === 1 ? "" : "s"} now available for ${providerId}.`,
                );
              }
            } catch (error) {
              messages.push(
                `⚠️ Failed to sync to multi-auth: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          await interaction.reply({
            content: messages.join("\n"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (interaction.customId.startsWith(LOGIN_OAUTH_MODAL_PREFIX)) {
          const rawProviderId = interaction.customId.slice(
            LOGIN_OAUTH_MODAL_PREFIX.length,
          );
          const [providerId, mode] = rawProviderId.split(":", 2);
          const provider = runtime.adapter
            .listLoginProviders()
            .find((entry) => entry.id === providerId);
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          if (mode === "prompt") {
            runtime.adapter.submitProviderOAuthPrompt(
              providerId,
              interaction.user.id,
              interaction.fields.getTextInputValue("prompt"),
            );
            await interaction.editReply({
              content: `${provider?.name ?? providerId} prompt answer submitted. Finish the browser/device step, then use Complete login.`,
            });
            return;
          }
          const code = interaction.fields.getTextInputValue("code");
          await runtime.adapter.completeProviderOAuthLogin(
            providerId,
            interaction.user.id,
            code,
          );
          const messages = [
            `${provider?.name ?? providerId} login completed successfully.`,
          ];
          if (multiAuthAccountManager) {
            try {
              // getProviderStatus triggers syncProviderState which re-reads auth.json
              // and discovers the OAuth credential just written by the pi SDK
              const status = await multiAuthAccountManager.getProviderStatus(
                providerId as SupportedProviderId,
              );
              await multiAuthAccountManager.autoActivatePreferredCredentials({
                avoidUsageApi: true,
              });
              if (status.credentials.length > 0) {
                messages.push(
                  `🔄 Synced to multi-auth rotation — **${status.credentials.length}** credential${status.credentials.length === 1 ? "" : "s"} now available.`,
                );
              }
            } catch (error) {
              messages.push(
                `⚠️ Multi-auth sync failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          await interaction.editReply({
            content: messages.join("\n"),
          });
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction
            .followUp({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        } else {
          await interaction
            .reply({ content: message, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        }
      }
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      const ownerAdminCommand = isOwnerAdminCommand(interaction.commandName);

      if (interaction.guildId && ownerAdminCommand) {
        if (["reload", "restart"].includes(interaction.commandName)) {
          requireOwnerOrAdmin(interaction, runtime);
        } else {
          requireOwner(interaction, runtime);
        }

        if (
          ownerAdminCommandRequiresHostChannel(
            interaction.commandName,
            interaction.options.getString("mode") ?? undefined,
          )
        ) {
          requireHostChannel(interaction, runtime);
        }
      }

      const access =
        interaction.guildId && ownerAdminCommand
          ? { allowed: true }
          : await checkInteractionAccess(interaction, runtime);

      if (!access.allowed) {
        await interaction.reply({
          content: access.reason ?? "Not allowed.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "reload") {
        if (!interaction.guildId) {
          requireOwner(interaction, runtime);
        }

        const thread = interaction.channel?.isThread()
          ? interaction.channel
          : undefined;
        const workspaceKey = runtime.getWorkspaceKeyForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          thread,
        });
        const conversationKey = runtime.getConversationKeyForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          thread,
        });

        if (
          interaction.guildId &&
          !thread &&
          !runtime.adapter.isManagedProjectChannel(interaction.channelId)
        ) {
          throw new Error(
            "Use /reload in a managed project channel, a session thread, or a DM.",
          );
        }

        const restarted = await runtime.adapter.restartSession(
          conversationKey,
          workspaceKey,
        );
        const visibleNotice = restarted
          ? "✅ Session restarted here. New config/tools will apply on the next message."
          : "✅ No bound session was active here, so the next message will already start fresh with the latest config/tools.";

        await interaction.reply({
          content:
            "Session reload complete. I will post confirmation in this location too.",
          flags: MessageFlags.Ephemeral,
        });

        if (interaction.channel && "send" in interaction.channel) {
          try {
            await interaction.channel.send({
              content: visibleNotice,
              allowedMentions: { parse: [] },
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            await interaction
              .followUp({
                content: `Session reload succeeded, but I could not post the visible confirmation here: ${message}`,
                flags: MessageFlags.Ephemeral,
              })
              .catch(() => undefined);
          }
        }
        return;
      }

      if (interaction.commandName === "restart") {
        requireGuild(interaction);
        await interaction.reply({
          content:
            "Queued picord restart. I will notify this channel once Picord is back online.",
          flags: MessageFlags.Ephemeral,
        });
        await runtime.adapter.restartRuntime({
          notifyChannelId: interaction.channelId,
          requestedByUserId: interaction.user.id,
          requestedByTag: interaction.user.tag,
        });
        return;
      }

      if (interaction.commandName === "multi-auth") {
        await handleMultiAuthCommand(interaction, multiAuthAccountManager!);
        return;
      }

      if (interaction.commandName === "login") {
        const providerOpt = interaction.options.getString("provider")?.trim();
        const keyOpt = interaction.options.getString("key")?.trim();

        if (providerOpt && keyOpt) {
          const providers = runtime.adapter.listLoginProviders();
          const provider = providers.find(
            (p) =>
              p.id === providerOpt ||
              p.name.toLowerCase() === providerOpt.toLowerCase(),
          );
          if (!provider) {
            await interaction.reply({
              content: `Unknown provider: ${providerOpt}. Use /login without options to see available providers.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          if (
            provider.id === "openai-codex" ||
            providerOpt.toLowerCase().includes("codex")
          ) {
            await interaction.reply({
              content:
                "**OpenAI Codex** uses OAuth login, not API keys. Use `/login` without options to start OAuth flow.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          if (provider.method === "api-key") {
            runtime.adapter.setProviderApiKey(provider.id, keyOpt);
            const messages = [
              `✅ Saved API key for **${provider.name}**. Your key is stored in auth.json and excluded from git.`,
            ];
            if (multiAuthAccountManager) {
              try {
                await multiAuthAccountManager.addApiKeyCredential(
                  provider.id as SupportedProviderId,
                  keyOpt,
                );
                messages.push("🔄 Added to multi-auth rotation.");
                const status = await multiAuthAccountManager.getProviderStatus(
                  provider.id as SupportedProviderId,
                );
                if (status.credentials.length > 0) {
                  messages.push(
                    `📊 **${status.credentials.length}** credential${status.credentials.length === 1 ? "" : "s"} now available for ${provider.name}.`,
                  );
                }
              } catch (error) {
                messages.push(
                  `⚠️ Failed to sync to multi-auth: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
            await interaction.reply({
              content: messages.join("\n"),
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          await interaction.reply({
            content: `**${provider.name}** uses OAuth, not direct API keys. Use /login without options to start OAuth flow.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        return await handleLoginCommand(interaction, runtime);
      }

      if (interaction.commandName === "project-create") {
        requireGuild(interaction);
        const created = await runtime.createNewProjectChannel({
          guild: interaction.guild!,
          projectName: interaction.options.getString("name", true),
          requestedBy: interaction.user,
        });
        if (!created) {
          await interaction.reply({
            content: "Project could not be created.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.reply({
          content: created.created
            ? `Created <#${created.textChannelId}> mapped to ${created.projectDirectory}`
            : `Reusing <#${created.textChannelId}> mapped to ${created.projectDirectory}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "add-project") {
        requireGuild(interaction);
        const availableProjects = runtime.listAvailableProjects();
        if (availableProjects.length === 0) {
          await interaction.reply({
            content: `No direct subfolders found under ${runtime.getProjectsDir()}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const visibleProjects = availableProjects.slice(0, 25);
        const menu = new StringSelectMenuBuilder()
          .setCustomId(ADD_PROJECT_SELECT)
          .setPlaceholder("Select a project to create or reuse its channel")
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            ...visibleProjects.map((project) => ({
              label: project.name.slice(0, 100),
              value: project.name,
              description: (project.managed
                ? `Already mapped to channel ${project.channelId}`
                : `Create a Picord channel for ${project.name}`
              ).slice(0, 100),
            })),
          );

        await interaction.reply({
          content: [
            `Pick a project under ${runtime.getProjectsDir()}.`,
            "",
            ...visibleProjects.map(
              (project) =>
                `- ${project.name}${project.managed ? ` (already mapped -> <#${project.channelId}>)` : ""}`,
            ),
            "",
            availableProjects.length > visibleProjects.length
              ? `Showing the first ${visibleProjects.length} of ${availableProjects.length} folders. Use /project-list-available to see the full list.`
              : "Selecting one will create or reuse a project channel under the Picord category.",
          ].join("\n"),
          flags: MessageFlags.Ephemeral,
          components: [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
          ],
        });
        return;
      }

      if (interaction.commandName === "add-project-path") {
        requireGuild(interaction);
        const projectDirectory = resolveProjectDirectory(
          runtime.adapter.config.cwd,
          interaction.options.getString("path", true),
        );
        if (
          !fs.existsSync(projectDirectory) ||
          !fs.statSync(projectDirectory).isDirectory()
        ) {
          await interaction.reply({
            content: `Directory does not exist: ${projectDirectory}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const mode = interaction.options.getString("mode", true);
        const projectName =
          interaction.options.getString("name")?.trim() || undefined;
        const gitWarning = (await isGitWorkspace(projectDirectory))
          ? undefined
          : "Warning: this directory is not inside a Git repository.";

        if (mode === "current-channel") {
          const channel = requireBindableGuildTextChannel(interaction, runtime);
          const bound = await runtime.bindCurrentProjectChannel({
            channel,
            projectDirectory,
            projectName,
          });
          await interaction.reply({
            content: [
              `Bound <#${bound.textChannelId}> to ${projectDirectory}`,
              gitWarning,
            ]
              .filter(Boolean)
              .join("\n"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const created = await runtime.addExistingProjectChannel({
          guild: interaction.guild!,
          projectDirectory,
          projectName,
          requestedBy: interaction.user,
        });
        await interaction.reply({
          content: [
            created.created
              ? `Created <#${created.textChannelId}> mapped to ${projectDirectory}`
              : `Reusing <#${created.textChannelId}> mapped to ${projectDirectory}`,
            gitWarning,
          ]
            .filter(Boolean)
            .join("\n"),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "scope-models") {
        const workspaceKey = getWorkspaceKey(runtime, interaction);
        const provider = interaction.options.getString("provider", true).trim();
        const query = interaction.options.getString("query")?.trim() ?? "";
        const result = runtime.findScopeModelChoices(
          workspaceKey,
          provider,
          query,
        );
        if (!result.providerExists) {
          await interaction.reply({
            content: `No configured models found for provider ${provider}.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (result.options.length === 0) {
          await interaction.reply({
            content: `No models matched ${provider}${query ? ` with filter "${query}"` : ""}.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`${SCOPE_MODELS_APPLY_PREFIX}${provider}`)
          .setPlaceholder(`Select scoped models for ${provider}`.slice(0, 150))
          .setMinValues(1)
          .setMaxValues(Math.min(result.options.length, 25))
          .addOptions(...result.options);
        const clearButton = new ButtonBuilder()
          .setCustomId(SCOPE_MODELS_CLEAR)
          .setLabel("Clear scope")
          .setStyle(ButtonStyle.Secondary);

        await interaction.reply({
          content: buildScopeModelsPrompt({
            provider,
            totalMatches: result.totalMatches,
            truncated: result.truncated,
            query,
          }),
          flags: MessageFlags.Ephemeral,
          components: [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
            new ActionRowBuilder<ButtonBuilder>().addComponents(clearButton),
          ],
        });
        return;
      }

      if (
        interaction.commandName === "use-model" ||
        interaction.commandName === "model"
      ) {
        if (interaction.guildId && isHostControlChannel(interaction, runtime)) {
          await interaction.reply({
            content:
              "Use /use-model in a project channel or session thread, not in the host control channel.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const thread = interaction.channel?.isThread()
          ? interaction.channel
          : undefined;
        const workspaceKey = runtime.getWorkspaceKeyForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          thread,
        });
        const conversationKey = runtime.getConversationKeyForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          thread,
        });
        const modelReference = interaction.options
          .getString("model", true)
          .trim();

        if (thread || !interaction.guildId) {
          const model = await runtime.adapter.setConversationModel(
            conversationKey,
            workspaceKey,
            modelReference,
          );
          await interaction.reply({
            content: `Session model set to ${model.provider}/${model.id}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const model = await runtime.adapter.setWorkspaceModel(
          workspaceKey,
          modelReference,
        );
        await interaction.reply({
          content: `Project default model set to ${model.provider}/${model.id}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "think") {
        if (interaction.guildId && isHostControlChannel(interaction, runtime)) {
          await interaction.reply({
            content:
              "Use /think in a project channel or session thread, not in the host control channel.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const thread = interaction.channel?.isThread()
          ? interaction.channel
          : undefined;
        const workspaceKey = runtime.getWorkspaceKeyForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          thread,
        });
        const conversationKey = runtime.getConversationKeyForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          thread,
        });
        const thinkingLevel = interaction.options.getString(
          "level",
          true,
        ) as import("../types.js").ThinkingLevel;

        if (thread || !interaction.guildId) {
          runtime.adapter.setConversationThinkingLevel(
            conversationKey,
            workspaceKey,
            thinkingLevel,
          );
          await interaction.reply({
            content: `Session thinking level set to ${thinkingLevel}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        runtime.adapter.setWorkspaceThinkingLevel(workspaceKey, thinkingLevel);
        await interaction.reply({
          content: `Project default thinking level set to ${thinkingLevel}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "think-visibility") {
        const thread = requireSessionThreadIfGuild(interaction);
        const conversationKey = runtime.getConversationKeyForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          thread,
        });
        const currentVisible =
          runtime.adapter.getThinkingVisibility(conversationKey);
        const newVisible = !currentVisible;
        runtime.adapter.setThinkingVisibility(conversationKey, newVisible);
        await interaction.reply({
          content: `Thinking visibility is now ${newVisible ? "shown" : "hidden"}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "ask") {
        const thread = requireSessionThreadIfGuild(interaction);
        const workspaceKey = runtime.getWorkspaceKeyForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          thread,
        });
        const conversationKey = runtime.getConversationKeyForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          thread,
        });
        const sessionName = runtime.getSessionNameForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          username: interaction.user.username,
          thread,
        });
        const promptText = interaction.options.getString("prompt", true).trim();
        if (!promptText) {
          await interaction.reply({
            content: "Prompt cannot be empty.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const thinkingVisible =
          runtime.adapter.getThinkingVisibility(conversationKey);
        const renderer = new LiveDiscordRunRenderer(
          createInteractionLiveMessageTarget(interaction, false),
          { thinkingVisible },
        );
        runtime.adapter.registerLiveRenderer(conversationKey, renderer);
        try {
          const response = await runtime.adapter.respond({
            conversationKey,
            workspaceKey,
            sessionName,
            promptText: buildPromptFromInteraction(interaction, promptText),
          });
          await renderer.finalize(response);
        } finally {
          runtime.adapter.clearLiveRenderer(conversationKey);
        }
        return;
      }

      if (interaction.commandName === "resume") {
        requireGuild(interaction);
        const thread = requireThread(interaction);
        const binding = runtime.bindThread(thread);
        const resumed = await runtime.adapter.resumeSession({
          conversationKey: binding.conversationKey,
          workspaceKey: binding.workspaceKey,
          sessionName: binding.sessionName,
          sessionReference: interaction.options.getString("session", true),
        });

        await interaction.reply({
          content: `Bound this thread to pi session ${resumed.id} (${resumed.name ?? "unnamed"}) from ${resumed.cwd}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "session") {
        requireGuild(interaction);
        const sessions = await runtime.adapter.listAllSessions(25);
        if (sessions.length === 0) {
          await interaction.reply({
            content: "No pi sessions were found.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const menu = new StringSelectMenuBuilder()
          .setCustomId(SESSION_SELECT)
          .setPlaceholder("Choose a session to restore")
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            ...sessions.map((session, index) => {
              const title =
                session.name?.trim() ||
                `${session.projectName} session ${index + 1}`;
              return {
                label: `${session.projectName} · ${title.slice(0, 70)}`.slice(
                  0,
                  100,
                ),
                value: session.id,
                description:
                  `${session.messageCount} msg · ${formatSessionModified(session.modified)}`.slice(
                    0,
                    100,
                  ),
              };
            }),
          );

        await interaction.reply({
          content: buildGroupedSessionLines(sessions).join("\n"),
          flags: MessageFlags.Ephemeral,
          components: [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
          ],
        });
        return;
      }

      if (interaction.commandName === "sessions") {
        const thread = interaction.channel?.isThread()
          ? interaction.channel
          : undefined;
        const workspaceKey = runtime.getWorkspaceKeyForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          thread,
        });
        await replyToInteraction(
          interaction,
          await runtime.describeAvailableSessions(workspaceKey),
        );
        return;
      }

      if (interaction.commandName === "abort") {
        requireGuild(interaction);
        const thread = requireThread(interaction);
        const binding = runtime.bindThread(thread);
        const aborted = await runtime.adapter.abort(binding.conversationKey);
        await interaction.reply({
          content: aborted
            ? "Active run aborted."
            : "No active session to abort.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "reset") {
        requireGuild(interaction);
        const thread = requireThread(interaction);
        const binding = runtime.bindThread(thread);
        const reset = await runtime.adapter.reset(binding.conversationKey);
        await interaction.reply({
          content: reset
            ? "Cleared the bound pi session for this thread."
            : "No bound session to clear.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "refresh-session") {
        requireGuild(interaction);
        const thread = requireThread(interaction);
        const binding = runtime.bindThread(thread);
        await runtime.adapter.abort(binding.conversationKey).catch(() => false);
        await runtime.adapter.reset(binding.conversationKey);
        await interaction.reply({
          content:
            "This thread session was refreshed. Send your next message again to start a clean session.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "project-list") {
        requireGuild(interaction);
        await replyToInteraction(
          interaction,
          await runtime.describeManagedProjects(interaction.guild!),
        );
        return;
      }

      if (interaction.commandName === "project-list-available") {
        requireGuild(interaction);
        await replyToInteraction(
          interaction,
          await runtime.describeAvailableProjects(),
        );
        return;
      }

      if (interaction.commandName === "diff") {
        const workspaceRoot = getCritiqueWorkspaceRoot(interaction, runtime);
        if (!(await isGitWorkspace(workspaceRoot))) {
          await interaction.reply({
            content: `Workspace is not inside a Git repository: ${workspaceRoot}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await shareGitDiff({
          cwd: workspaceRoot,
          title: `${path.basename(workspaceRoot)}: Discord /diff`,
        });
        await replyToInteraction(
          interaction,
          result?.url ?? result?.error ?? "No changes to show.",
        );
        return;
      }

      if (interaction.commandName === "review") {
        const workspaceRoot = getCritiqueWorkspaceRoot(interaction, runtime);
        if (!(await isGitWorkspace(workspaceRoot))) {
          await interaction.reply({
            content: `Workspace is not inside a Git repository: ${workspaceRoot}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await reviewGitDiff({ cwd: workspaceRoot });
        await replyToInteraction(
          interaction,
          result?.url ?? result?.error ?? "No review output was generated.",
        );
        return;
      }

      if (interaction.commandName === "access-requests") {
        requireGuild(interaction);
        const requests = runtime.adapter.getPendingAccessRequests();
        await replyToInteraction(
          interaction,
          requests.length > 0
            ? requests
                .map((request) => `${request.id} :: ${request.summary}`)
                .join("\n\n")
            : "No pending access requests.",
        );
        return;
      }

      if (interaction.commandName === "outside-workspace-access") {
        requireGuild(interaction);
        const mode = interaction.options.getString("mode", true);

        if (isHostControlChannel(interaction, runtime)) {
          const projects = runtime.adapter.listManagedProjects().slice(0, 25);
          if (projects.length === 0) {
            await interaction.reply({
              content: "No managed projects are available.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const menu = new StringSelectMenuBuilder()
            .setCustomId(OUTSIDE_WORKSPACE_PROJECT_SELECT)
            .setPlaceholder(
              `Select a project to ${mode} outside-workspace access`,
            )
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
              ...projects.map((project) => ({
                label: (project.name?.trim() || project.channelId).slice(
                  0,
                  100,
                ),
                value: project.channelId,
                description:
                  `${runtime.adapter.isOutsideWorkspaceAllowed(runtime.buildWorkspaceKey(interaction.guildId!, project.channelId)) ? "enabled" : "disabled"} • ${project.root}`.slice(
                    0,
                    100,
                  ),
              })),
            );

          await interaction.reply({
            content: `Choose a project to ${mode} outside-workspace access.`,
            flags: MessageFlags.Ephemeral,
            components: [
              new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                menu,
              ),
            ],
          });
          return;
        }

        const channel = interaction.channel;
        const workspaceChannelId = channel?.isThread()
          ? (channel.parentId ?? interaction.channelId)
          : interaction.channelId;
        if (!runtime.adapter.isManagedProjectChannel(workspaceChannelId)) {
          throw new Error(
            "Use this command in the host control channel, a managed project channel, or a session thread.",
          );
        }

        const workspaceKey = runtime.buildWorkspaceKey(
          interaction.guildId!,
          workspaceChannelId,
        );
        const allowed = mode === "allow";
        runtime.adapter.setOutsideWorkspaceAllowed(workspaceKey, allowed);
        await interaction.reply({
          content: allowed
            ? [
                `Outside-workspace access is now enabled for <#${workspaceChannelId}>.`,
                `Blocked sensitive paths still remain protected.`,
              ].join("\n")
            : `Outside-workspace access is now disabled for <#${workspaceChannelId}>.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "status") {
        const content = !interaction.guildId
          ? runtime.buildDirectMessageStatus(
              interaction.channelId,
              interaction.user.username,
            )
          : interaction.channel?.isThread()
            ? runtime.buildThreadStatus(interaction.channel)
            : runtime.buildGuildStatus({
                guildId: interaction.guildId,
                channelId: interaction.channelId,
              });

        await replyToInteraction(interaction, content);
        return;
      }

      if (
        interaction.commandName.startsWith("multi-auth") &&
        multiAuthAccountManager
      ) {
        await handleMultiAuthCommand(interaction, multiAuthAccountManager);
        return;
      }

      const skillCommand = findSkillCommand(interaction.commandName, runtime);
      if (skillCommand) {
        const thread = requireSessionThreadIfGuild(interaction);
        const workspaceKey = runtime.getWorkspaceKeyForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          thread,
        });
        const conversationKey = runtime.getConversationKeyForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          thread,
        });
        const sessionName = runtime.getSessionNameForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          username: interaction.user.username,
          thread,
        });
        const skillArgs = interaction.options.getString("prompt")?.trim();

        await interaction.deferReply(); // No ephemeral flag
        const thinkingVisible =
          runtime.adapter.getThinkingVisibility(conversationKey);
        const renderer = new LiveDiscordRunRenderer(
          createInteractionLiveMessageTarget(interaction, false),
          { thinkingVisible },
        );
        renderer.setSkillContext(skillCommand.name, skillArgs);
        runtime.adapter.registerLiveRenderer(conversationKey, renderer);
        try {
          const response = await runtime.adapter.invokeSkill({
            conversationKey,
            workspaceKey,
            sessionName,
            skillName: skillCommand.name,
            args: skillArgs,
          });
          await renderer.finalize(response);
        } finally {
          runtime.adapter.clearLiveRenderer(conversationKey);
        }
        return;
      }

      if (
        interaction.commandName === "compact" ||
        interaction.commandName === "auto-compact"
      ) {
        const thread = requireSessionThreadIfGuild(interaction);
        const conversationKey = runtime.getConversationKeyForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          thread,
        });

        if (interaction.commandName === "compact") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          try {
            const success =
              await runtime.adapter.compactSession(conversationKey);
            await interaction.editReply({
              content: success
                ? "✅ Context compaction completed successfully."
                : "⚠️ No active session found to compact.",
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === "Already compacted") {
              await interaction.editReply({
                content: "⚠️ Session was already compacted. Send more messages before compacting again.",
              });
            } else if (msg === "Nothing to compact (session too small)") {
              await interaction.editReply({
                content: "⚠️ Context is too small to compact. Compaction only works when the context is large enough to summarize.",
              });
            } else {
              await interaction.editReply({
                content: `❌ Compaction failed: ${msg}`,
              });
            }
          }
          return;
        }

        const currentEnabled =
          runtime.adapter.getAutoCompactionEnabled(conversationKey);
        runtime.adapter.setAutoCompactionEnabled(
          conversationKey,
          !currentEnabled,
        );
        await interaction.reply({
          content: `♻️ Automatic compaction is now ${currentEnabled ? "disabled" : "enabled"}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (interaction.deferred || interaction.replied) {
        await interaction
          .followUp({ content: message, flags: MessageFlags.Ephemeral })
          .catch(() => undefined);
      } else {
        await interaction
          .reply({ content: message, flags: MessageFlags.Ephemeral })
          .catch(() => undefined);
      }
    }
  });
}
