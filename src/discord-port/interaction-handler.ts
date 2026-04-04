import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  MessageFlags,
  ModalBuilder,
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
import type { ApprovalDecisionMode } from "../access-approval.js";
import {
  buildEffectiveAccessConfig,
  extractMemberRoleIds,
  getWorkspaceChannelIdFromInteraction,
} from "./access-control.js";
import { isGitWorkspace, reviewGitDiff, shareGitDiff } from "../critique.js";
import { buildPromptFromInteraction, replyToInteraction } from "./message-helpers.js";
import type { DiscordPortRuntime } from "./runtime.js";

const SCOPE_MODELS_APPLY_PREFIX = "scope-models:apply:";
const SCOPE_MODELS_CLEAR = "scope-models:clear";
const ADD_PROJECT_SELECT = "add-project:select";
const LOGIN_PROVIDER_SELECT = "login:provider";
const LOGIN_OPENAI_COMPLETE = "login:openai:complete";
const LOGIN_API_KEY_MODAL_PREFIX = "login:api-key:";
const LOGIN_OPENAI_MODAL = "login:openai:modal";
const SESSION_SELECT = "session:select";

function requireGuild(interaction: ChatInputCommandInteraction): asserts interaction is ChatInputCommandInteraction & { guildId: string } {
  if (!interaction.guildId) {
    throw new Error("This command can only be used in a guild.");
  }
}

function requireThread(interaction: ChatInputCommandInteraction) {
  const channel = interaction.channel;
  if (!channel || (channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread)) {
    throw new Error("Use this command inside a Discord thread. Project channel = workspace, thread = pi session.");
  }
  return channel;
}

function requireSessionThreadIfGuild(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    return undefined;
  }
  return requireThread(interaction);
}

function requireOwner(interaction: ChatInputCommandInteraction, runtime: DiscordPortRuntime): void {
  if (!runtime.adapter.isOwner(interaction.user.id)) {
    throw new Error("Only the configured owner can use this command.");
  }
}

function isHostControlChannel(interaction: ChatInputCommandInteraction, runtime: DiscordPortRuntime): boolean {
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

function requireHostChannel(interaction: ChatInputCommandInteraction, runtime: DiscordPortRuntime): void {
  if (!isHostControlChannel(interaction, runtime)) {
    throw new Error(`Use this command in #${runtime.adapter.config.hostChannelName}.`);
  }
}

function isOwnerAdminCommand(commandName: string): boolean {
  return [
    "reload",
    "login",
    "project-create",
    "add-project",
    "add-project-path",
    "project-list",
    "project-list-available",
    "session",
    "access-requests",
    "access-allow",
    "access-deny",
  ].includes(commandName);
}

function findSkillCommand(commandName: string, runtime: DiscordPortRuntime) {
  return runtime.adapter.listSkillSummaries().find((skill) => skill.name === commandName);
}

function getThreadFromInteractionChannel(channel: Interaction["channel"]): ChatInputCommandInteraction["channel"] | undefined {
  if (!channel || (channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread)) {
    return undefined;
  }
  return channel as ChatInputCommandInteraction["channel"];
}

function getWorkspaceKey(
  runtime: DiscordPortRuntime,
  interaction: Interaction & { guildId?: string | null; channelId: string; channel?: Interaction["channel"] | null },
) {
  return runtime.getWorkspaceKeyForLocation({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    thread: getThreadFromInteractionChannel(interaction.channel) as never,
  });
}

function buildScopeModelsPrompt({ provider, totalMatches, truncated, query }: {
  provider: string;
  totalMatches: number;
  truncated: boolean;
  query: string;
}) {
  return [
    `Select scoped models for ${provider}.`,
    query ? `Filter: ${query}` : undefined,
    truncated ? `Showing the first 25 of ${totalMatches} matches. Narrow the query if needed.` : `Matches: ${totalMatches}`,
    "This replaces the workspace scope. Use /use-model after this to choose the active model.",
  ].filter((line): line is string => Boolean(line)).join("\n");
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

export function buildGroupedSessionLines(sessions: Array<{
  projectName: string;
  name?: string;
  messageCount: number;
  modified: Date;
  cwd: string;
}>): string[] {
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
    const title = session.name?.trim() || `${session.projectName} session ${projectSessionIndex}`;
    lines.push(`- ${title}`);
    lines.push(`  ${session.messageCount} msg · ${formatSessionModified(session.modified)}`);
    lines.push(`  ${session.cwd}`);
  }

  return lines;
}

export function buildLoginProviderLines(providers: Array<{
  name: string;
  method: "api-key" | "oauth";
  hasStoredAuth: boolean;
}>): string[] {
  return [
    "Choose a provider to log in or update.",
    ...providers.slice(0, 25).map((provider) => `- ${provider.name} (${provider.method}${provider.hasStoredAuth ? ", configured" : ", not configured"})`),
  ];
}

function resolveProjectDirectory(baseDir: string, inputPath: string): string {
  const trimmed = inputPath.trim();
  const expanded = trimmed === "~"
    ? process.env.HOME ?? trimmed
    : trimmed.startsWith("~/")
      ? path.join(process.env.HOME ?? "", trimmed.slice(2))
      : trimmed;
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function requireBindableGuildTextChannel(interaction: ChatInputCommandInteraction, runtime: DiscordPortRuntime): TextChannel {
  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error("Current-channel mode only works in a guild text channel.");
  }
  if (isHostControlChannel(interaction, runtime)) {
    throw new Error("The host control channel cannot be rebound as a project channel.");
  }
  return channel;
}

function getCritiqueWorkspaceRoot(interaction: ChatInputCommandInteraction, runtime: DiscordPortRuntime): string {
  if (!interaction.guildId) {
    return runtime.adapter.getWorkspaceInfo(getWorkspaceKey(runtime, interaction)).root;
  }

  if (interaction.channel?.isThread()) {
    return runtime.adapter.getWorkspaceInfo(getWorkspaceKey(runtime, interaction)).root;
  }

  if (runtime.adapter.isManagedProjectChannel(interaction.channelId)) {
    return runtime.adapter.getWorkspaceInfo(getWorkspaceKey(runtime, interaction)).root;
  }

  throw new Error("Use this command in a managed project channel, a session thread, or a DM.");
}

async function checkInteractionAccess(
  interaction: Interaction & { guildId?: string | null; guild?: Interaction["guild"] | null; user: { id: string }; channelId: string; member?: unknown },
  runtime: DiscordPortRuntime,
) {
  const effectiveConfig = interaction.guild
    ? await buildEffectiveAccessConfig(runtime.adapter.config, runtime.adapter, interaction.guild)
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
  onReload,
}: {
  client: Client;
  runtime: DiscordPortRuntime;
  onReload?: () => void;
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
        if (interaction.commandName === "scope-models" && focused.name === "provider") {
          await interaction.respond(runtime.findProviderChoices(String(focused.value ?? "")));
          return;
        }

        if (interaction.commandName === "resume" || interaction.commandName === "use-model" || interaction.commandName === "model") {
          const workspaceKey = getWorkspaceKey(runtime, interaction);
          const query = String(focused.value ?? "");
          const choices = interaction.commandName === "resume"
            ? await runtime.findResumeChoices(workspaceKey, query)
            : runtime.findModelChoices(workspaceKey, query);
          await interaction.respond(choices);
          return;
        }

        await interaction.respond([]);
      } catch {
        await interaction.respond([]).catch(() => undefined);
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === SESSION_SELECT) {
      try {
        requireOwner(interaction as never, runtime);
        requireHostChannel(interaction as never, runtime);
        if (!interaction.guild) throw new Error("This action can only be used in a guild.");

        const sessionId = interaction.values[0]?.trim();
        if (!sessionId) throw new Error("No session was selected.");
        const session = (await runtime.adapter.listAllSessions(100)).find((entry) => entry.id === sessionId);
        if (!session) throw new Error("Selected session no longer exists.");

        const created = await runtime.addExistingProjectChannel({
          guild: interaction.guild,
          projectDirectory: session.cwd,
          projectName: session.projectName,
          requestedBy: interaction.user,
        });
        const channel = await interaction.guild.channels.fetch(created.textChannelId);
        if (!channel || channel.type !== ChannelType.GuildText) {
          throw new Error("Project channel could not be loaded.");
        }
        const thread = await channel.threads.create({
          name: (session.name?.trim() || `${session.projectName} session`).slice(0, 100),
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
          await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        } else {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        }
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === LOGIN_PROVIDER_SELECT) {
      try {
        requireOwner(interaction as never, runtime);
        requireHostChannel(interaction as never, runtime);

        const providerId = interaction.values[0]?.trim();
        if (!providerId) {
          throw new Error("No provider was selected.");
        }

        const provider = runtime.adapter.listLoginProviders().find((entry) => entry.id === providerId);
        if (!provider) {
          throw new Error(`Unknown provider: ${providerId}`);
        }

        if (provider.id === "openai-codex") {
          const started = await runtime.adapter.startOpenAICodexLogin(interaction.user.id);
          const button = new ButtonBuilder()
            .setCustomId(LOGIN_OPENAI_COMPLETE)
            .setLabel("Paste login code")
            .setStyle(ButtonStyle.Primary);

          await interaction.update({
            content: [
              `OpenAI Codex login started for **${provider.name}**.`,
              "Open the login link on another device/browser and complete sign-in.",
              `Auth URL: ${started.url}`,
              started.instructions ?? "After login, paste the resulting code or full redirect URL.",
            ].join("\n\n"),
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId(`${LOGIN_API_KEY_MODAL_PREFIX}${provider.id}`)
          .setTitle(`Set ${provider.name} API key`)
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("apiKey")
                .setLabel("API key")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true),
            ),
          );
        await interaction.showModal(modal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        } else {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        }
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === ADD_PROJECT_SELECT) {
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

        const project = runtime.listAvailableProjects().find((entry) => entry.name === selectedName);
        if (!project) {
          throw new Error(`Project not found under ${runtime.getProjectsDir()}: ${selectedName}`);
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
          await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        } else {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        }
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith(SCOPE_MODELS_APPLY_PREFIX)) {
      try {
        const access = await checkInteractionAccess(interaction, runtime);
        if (!access.allowed) {
          await interaction.reply({ content: access.reason ?? "Not allowed.", flags: MessageFlags.Ephemeral });
          return;
        }

        const workspaceKey = getWorkspaceKey(runtime, interaction);
        const scope = runtime.adapter.setWorkspaceModelScope(workspaceKey, interaction.values.join(" "));
        await interaction.update({
          content: `Workspace model scope updated to ${scope.models.length} model${scope.models.length === 1 ? "" : "s"}. Use /use-model to pick the active model.`,
          components: [],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        } else {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        }
      }
      return;
    }

    if (interaction.isButton() && interaction.customId === LOGIN_OPENAI_COMPLETE) {
      try {
        requireOwner(interaction as never, runtime);
        requireHostChannel(interaction as never, runtime);
        const modal = new ModalBuilder()
          .setCustomId(LOGIN_OPENAI_MODAL)
          .setTitle("Complete OpenAI Codex login")
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("code")
                .setLabel("Authorization code or redirect URL")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true),
            ),
          );
        await interaction.showModal(modal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        } else {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        }
      }
      return;
    }

    if (interaction.isButton() && interaction.customId === SCOPE_MODELS_CLEAR) {
      try {
        const access = await checkInteractionAccess(interaction, runtime);
        if (!access.allowed) {
          await interaction.reply({ content: access.reason ?? "Not allowed.", flags: MessageFlags.Ephemeral });
          return;
        }

        const workspaceKey = getWorkspaceKey(runtime, interaction);
        runtime.adapter.clearWorkspaceModelScope(workspaceKey);
        await interaction.update({
          content: "Workspace model scope cleared. /use-model will show all configured models again.",
          components: [],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        } else {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        }
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      try {
        requireOwner(interaction as never, runtime);
        requireHostChannel(interaction as never, runtime);

        if (interaction.customId.startsWith(LOGIN_API_KEY_MODAL_PREFIX)) {
          const providerId = interaction.customId.slice(LOGIN_API_KEY_MODAL_PREFIX.length);
          runtime.adapter.setProviderApiKey(providerId, interaction.fields.getTextInputValue("apiKey"));
          await interaction.reply({
            content: `Stored API key for ${providerId}.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (interaction.customId === LOGIN_OPENAI_MODAL) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await runtime.adapter.completeOpenAICodexLogin(interaction.user.id, interaction.fields.getTextInputValue("code"));
          await interaction.editReply({ content: "OpenAI Codex login completed successfully." });
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        } else {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
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
        requireOwner(interaction, runtime);
        const isCurrentChannelBind = interaction.commandName === "add-project-path"
          && interaction.options.getString("mode") === "current-channel";
        if (!isCurrentChannelBind) {
          requireHostChannel(interaction, runtime);
        }
      }

      const access = interaction.guildId && ownerAdminCommand
        ? { allowed: true }
        : await checkInteractionAccess(interaction, runtime);

      if (!access.allowed) {
        await interaction.reply({ content: access.reason ?? "Not allowed.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.commandName === "reload") {
        requireGuild(interaction);
        await interaction.reply({
          content: "Queued pi /reload.",
          flags: MessageFlags.Ephemeral,
        });
        onReload?.();
        return;
      }

      if (interaction.commandName === "login") {
        requireGuild(interaction);
        const providers = runtime.adapter.listLoginProviders();
        if (providers.length === 0) {
          await interaction.reply({
            content: "No login providers are available.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const menu = new StringSelectMenuBuilder()
          .setCustomId(LOGIN_PROVIDER_SELECT)
          .setPlaceholder("Choose a provider to log in or replace its API key")
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(...providers.slice(0, 25).map((provider) => ({
            label: provider.name.slice(0, 100),
            value: provider.id,
            description: `${provider.method === "oauth" ? "OAuth / subscription login" : "Set or replace API key"}${provider.hasStoredAuth ? " • already configured" : " • not configured"}`.slice(0, 100),
          })));

        await interaction.reply({
          content: buildLoginProviderLines(providers).join("\n"),
          flags: MessageFlags.Ephemeral,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
        });
        return;
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
          .addOptions(...visibleProjects.map((project) => ({
            label: project.name.slice(0, 100),
            value: project.name,
            description: (project.managed
              ? `Already mapped to channel ${project.channelId}`
              : `Create a Picord channel for ${project.name}`).slice(0, 100),
          })));

        await interaction.reply({
          content: [
            `Pick a project under ${runtime.getProjectsDir()}.`,
            "",
            ...visibleProjects.map((project) => `- ${project.name}${project.managed ? ` (already mapped -> <#${project.channelId}>)` : ""}`),
            "",
            availableProjects.length > visibleProjects.length
              ? `Showing the first ${visibleProjects.length} of ${availableProjects.length} folders. Use /project-list-available to see the full list.`
              : "Selecting one will create or reuse a project channel under the Picord category.",
          ].join("\n"),
          flags: MessageFlags.Ephemeral,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
        });
        return;
      }

      if (interaction.commandName === "add-project-path") {
        requireGuild(interaction);
        const projectDirectory = resolveProjectDirectory(runtime.adapter.config.cwd, interaction.options.getString("path", true));
        if (!fs.existsSync(projectDirectory) || !fs.statSync(projectDirectory).isDirectory()) {
          await interaction.reply({
            content: `Directory does not exist: ${projectDirectory}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const mode = interaction.options.getString("mode", true);
        const projectName = interaction.options.getString("name")?.trim() || undefined;
        const gitWarning = await isGitWorkspace(projectDirectory)
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
            ].filter(Boolean).join("\n"),
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
          ].filter(Boolean).join("\n"),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "scope-models") {
        const workspaceKey = getWorkspaceKey(runtime, interaction);
        const provider = interaction.options.getString("provider", true).trim();
        const query = interaction.options.getString("query")?.trim() ?? "";
        const result = runtime.findScopeModelChoices(workspaceKey, provider, query);
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

      if (interaction.commandName === "use-model" || interaction.commandName === "model") {
        if (interaction.guildId && isHostControlChannel(interaction, runtime)) {
          await interaction.reply({
            content: "Use /use-model in a project channel or session thread, not in the host control channel.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const thread = interaction.channel?.isThread() ? interaction.channel : undefined;
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
        const modelReference = interaction.options.getString("model", true).trim();

        if (thread || !interaction.guildId) {
          const model = await runtime.adapter.setConversationModel(conversationKey, workspaceKey, modelReference);
          await interaction.reply({
            content: `Session model set to ${model.provider}/${model.id}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const model = await runtime.adapter.setWorkspaceModel(workspaceKey, modelReference);
        await interaction.reply({
          content: `Project default model set to ${model.provider}/${model.id}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "think") {
        if (interaction.guildId && isHostControlChannel(interaction, runtime)) {
          await interaction.reply({
            content: "Use /think in a project channel or session thread, not in the host control channel.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const thread = interaction.channel?.isThread() ? interaction.channel : undefined;
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
        const thinkingLevel = interaction.options.getString("level", true) as import("../types.js").ThinkingLevel;

        if (thread || !interaction.guildId) {
          runtime.adapter.setConversationThinkingLevel(conversationKey, workspaceKey, thinkingLevel);
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
          await interaction.reply({ content: "Prompt cannot be empty.", flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const response = await runtime.adapter.respond({
          conversationKey,
          workspaceKey,
          sessionName,
          promptText: buildPromptFromInteraction(interaction, promptText),
        });
        await replyToInteraction(interaction, response);
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
          .addOptions(...sessions.map((session, index) => {
            const title = session.name?.trim() || `${session.projectName} session ${index + 1}`;
            return {
              label: `${session.projectName} · ${title.slice(0, 70)}`.slice(0, 100),
              value: session.id,
              description: `${session.messageCount} msg · ${formatSessionModified(session.modified)}`.slice(0, 100),
            };
          }));

        await interaction.reply({
          content: buildGroupedSessionLines(sessions).join("\n"),
          flags: MessageFlags.Ephemeral,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
        });
        return;
      }

      if (interaction.commandName === "sessions") {
        const thread = interaction.channel?.isThread() ? interaction.channel : undefined;
        const workspaceKey = runtime.getWorkspaceKeyForLocation({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          thread,
        });
        await replyToInteraction(interaction, await runtime.describeAvailableSessions(workspaceKey));
        return;
      }

      if (interaction.commandName === "abort") {
        requireGuild(interaction);
        const thread = requireThread(interaction);
        const binding = runtime.bindThread(thread);
        const aborted = await runtime.adapter.abort(binding.conversationKey);
        await interaction.reply({
          content: aborted ? "Active run aborted." : "No active session to abort.",
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
          content: reset ? "Cleared the bound pi session for this thread." : "No bound session to clear.",
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
          content: "This thread session was refreshed. Send your next message again to start a clean session.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "project-list") {
        requireGuild(interaction);
        await replyToInteraction(interaction, await runtime.describeManagedProjects(interaction.guild!));
        return;
      }

      if (interaction.commandName === "project-list-available") {
        requireGuild(interaction);
        await replyToInteraction(interaction, await runtime.describeAvailableProjects());
        return;
      }

      if (interaction.commandName === "diff") {
        const workspaceRoot = getCritiqueWorkspaceRoot(interaction, runtime);
        if (!await isGitWorkspace(workspaceRoot)) {
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
        await replyToInteraction(interaction, result?.url ?? result?.error ?? "No changes to show.");
        return;
      }

      if (interaction.commandName === "review") {
        const workspaceRoot = getCritiqueWorkspaceRoot(interaction, runtime);
        if (!await isGitWorkspace(workspaceRoot)) {
          await interaction.reply({
            content: `Workspace is not inside a Git repository: ${workspaceRoot}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await reviewGitDiff({ cwd: workspaceRoot });
        await replyToInteraction(interaction, result?.url ?? result?.error ?? "No review output was generated.");
        return;
      }

      if (interaction.commandName === "access-requests") {
        requireGuild(interaction);
        const requests = runtime.adapter.getPendingAccessRequests();
        await replyToInteraction(
          interaction,
          requests.length > 0
            ? requests.map((request) => `${request.id} :: ${request.summary}`).join("\n\n")
            : "No pending access requests.",
        );
        return;
      }

      if (interaction.commandName === "access-allow") {
        requireGuild(interaction);
        const requestId = interaction.options.getString("request_id", true);
        const mode = interaction.options.getString("mode", true) as ApprovalDecisionMode;
        const request = runtime.adapter.resolveAccessRequest(requestId, mode);
        await interaction.reply({
          content: request ? `Approved ${requestId} (${mode}).` : `No pending access request with id ${requestId}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "access-deny") {
        requireGuild(interaction);
        const requestId = interaction.options.getString("request_id", true);
        const request = runtime.adapter.resolveAccessRequest(requestId, "deny");
        await interaction.reply({
          content: request ? `Denied ${requestId}.` : `No pending access request with id ${requestId}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "status") {
        const content = !interaction.guildId
          ? runtime.buildDirectMessageStatus(interaction.channelId, interaction.user.username)
          : interaction.channel?.isThread()
            ? runtime.buildThreadStatus(interaction.channel)
            : runtime.buildGuildStatus({ guildId: interaction.guildId, channelId: interaction.channelId });

        await replyToInteraction(interaction, content);
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

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const response = await runtime.adapter.invokeSkill({
          conversationKey,
          workspaceKey,
          sessionName,
          skillName: skillCommand.name,
          args: skillArgs,
        });
        await replyToInteraction(interaction, response);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      }
    }
  });
}
