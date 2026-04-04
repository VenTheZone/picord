import { ChannelType, type Client, type Guild, type Message, type TextChannel, type ThreadChannel, type User } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { buildPromptFromMessage } from "./message-helpers.js";
import type { ModelSummary } from "../types.js";
import type { DiscordPortRuntimeAdapter, DiscordPortThreadBinding, PiAvailableSessionSummary } from "./types.js";
import { addExistingProject, createNewProject, postProjectCreatedMessage } from "./project-management.js";

export class DiscordPortRuntime {
  constructor(
    readonly client: Client,
    readonly adapter: DiscordPortRuntimeAdapter,
  ) {}

  listAvailableProjects(limit?: number): Array<{
    name: string;
    root: string;
    managed: boolean;
    channelId?: string;
  }> {
    const basePath = this.getProjectsDir();
    if (!fs.existsSync(basePath)) {
      return [];
    }

    const managedByRoot = new Map(
      this.adapter.listManagedProjects().map((project) => [path.resolve(project.root), project]),
    );

    const entries = fs.readdirSync(basePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const root = path.join(basePath, entry.name);
        const managed = managedByRoot.get(path.resolve(root));
        return {
          name: entry.name,
          root,
          managed: Boolean(managed),
          channelId: managed?.channelId,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    return typeof limit === "number" ? entries.slice(0, limit) : entries;
  }

  getProjectsDir(): string {
    return this.adapter.config.workspaceBasePath;
  }

  async createNewProjectChannel({ guild, projectName, requestedBy }: {
    guild: Guild;
    projectName: string;
    requestedBy?: { id: string };
  }) {
    const created = await createNewProject({
      guild,
      projectName,
      projectsDir: this.getProjectsDir(),
      adapter: this.adapter,
    });
    if (!created) {
      return null;
    }

    const fetched = await guild.channels.fetch(created.textChannelId);
    if (fetched?.type === 0) {
      await postProjectCreatedMessage({
        textChannel: fetched as TextChannel,
        user: requestedBy ? ({ id: requestedBy.id } as { id: string }) as never : undefined,
        projectDirectory: created.projectDirectory,
      });
    }

    return created;
  }

  async addExistingProjectChannel({
    guild,
    projectDirectory,
    projectName,
    requestedBy,
  }: {
    guild: Guild;
    projectDirectory: string;
    projectName?: string;
    requestedBy?: User | { id: string };
  }) {
    const created = await addExistingProject({
      guild,
      projectDirectory,
      adapter: this.adapter,
      projectName,
    });

    const fetched = await guild.channels.fetch(created.textChannelId);
    if (fetched?.type === 0) {
      await postProjectCreatedMessage({
        textChannel: fetched as TextChannel,
        user: requestedBy ? ({ id: requestedBy.id } as { id: string }) as never : undefined,
        projectDirectory,
      });
    }

    return created;
  }

  async bindCurrentProjectChannel({
    channel,
    projectDirectory,
    projectName,
  }: {
    channel: TextChannel;
    projectDirectory: string;
    projectName?: string;
  }) {
    const name = projectName?.trim() || channel.name;
    await this.adapter.addManagedProject(channel.id, projectDirectory, name);
    await channel.setTopic(`picord workspace → ${projectDirectory}`).catch(() => undefined);
    return {
      textChannelId: channel.id,
      channelName: channel.name,
      projectDirectory,
      sanitizedName: name,
      created: false,
    };
  }

  buildWorkspaceKey(guildId: string, channelId: string): string {
    return `discord:guild:${guildId}:workspace:${channelId}`;
  }

  buildConversationKeyForThread(guildId: string, threadId: string): string {
    return `discord:guild:${guildId}:thread:${threadId}`;
  }

  bindThread(thread: ThreadChannel): DiscordPortThreadBinding {
    const guildId = thread.guildId;
    return {
      thread,
      workspaceKey: this.buildWorkspaceKey(guildId, thread.parentId ?? thread.id),
      conversationKey: this.buildConversationKeyForThread(guildId, thread.id),
      sessionName: thread.name,
    };
  }

  buildConversationKeyForProjectChannel(guildId: string, channelId: string): string {
    return `discord:guild:${guildId}:channel:${channelId}`;
  }

  buildWorkspaceKeyForDirectMessage(channelId: string): string {
    return `discord:dm:${channelId}`;
  }

  buildConversationKeyForDirectMessage(channelId: string): string {
    return `discord:dm:${channelId}`;
  }

  async continueThread({ thread, message }: { thread: ThreadChannel; message: Message }): Promise<string> {
    const binding = this.bindThread(thread);
    const basePrompt = buildPromptFromMessage(message, message.content.trim());
    return this.adapter.respond({
      conversationKey: binding.conversationKey,
      workspaceKey: binding.workspaceKey,
      sessionName: binding.sessionName,
      promptText: [
        basePrompt,
        "",
        `[Session thread context]`,
        `ThreadId: ${thread.id}`,
        `WorkspaceChannel: ${thread.parentId ?? "unknown"}`,
      ].join("\n"),
    });
  }

  buildStatusLines({
    workspaceKey,
    conversationKey,
    sessionName,
    managedProjectChannel,
    locationLabel,
  }: {
    workspaceKey: string;
    conversationKey: string;
    sessionName: string;
    managedProjectChannel: boolean;
    locationLabel: string;
  }): string[] {
    const workspaceInfo = this.adapter.getWorkspaceInfo(workspaceKey);
    const workspaceScope = this.adapter.getWorkspaceModelScope(workspaceKey);
    const boundSession = this.adapter.getBoundSessionSummary(conversationKey);

    const effectiveModel = this.adapter.getEffectiveModel(conversationKey, workspaceKey);
    const effectiveThinkingLevel = this.adapter.getEffectiveThinkingLevel(conversationKey, workspaceKey);

    return [
      "discord-port runtime status",
      `runtimeArch: discord-port`,
      `location: ${locationLabel}`,
      `workspaceRoot: ${workspaceInfo.root}`,
      `workspaceKey: ${workspaceKey}`,
      `conversationKey: ${conversationKey}`,
      `sessionName: ${sessionName}`,
      `sessionBound: ${this.adapter.hasBoundSession(conversationKey)}`,
      boundSession ? `boundSessionId: ${boundSession.id}` : undefined,
      boundSession?.name ? `boundSessionName: ${boundSession.name}` : undefined,
      boundSession?.path ? `boundSessionPath: ${boundSession.path}` : undefined,
      `managedProjectChannel: ${managedProjectChannel}`,
      `activeSessions: ${this.adapter.getSessionCount()}`,
      effectiveModel ? `activeModel: ${effectiveModel.provider}/${effectiveModel.id}` : undefined,
      `activeThinkingLevel: ${effectiveThinkingLevel}`,
      `workspaceScopedModels: ${workspaceScope.models.length}`,
      `workspaceScopePatterns: ${workspaceScope.patterns.join(", ") || "(none)"}`,
      `blockedPathPatterns: ${this.adapter.getBlockedPathPatterns().join(", ") || "(none)"}`,
      `skills: ${this.adapter.getSkillSummaries().length}`,
      `ownerConfigured: ${Boolean(this.adapter.config.ownerUserId)}`,
      `hostChannelId: ${this.adapter.config.hostChannelId ?? "(unresolved)"}`,
    ].filter((line): line is string => Boolean(line));
  }

  buildThreadStatus(thread: ThreadChannel): string {
    const binding = this.bindThread(thread);
    return this.buildStatusLines({
      workspaceKey: binding.workspaceKey,
      conversationKey: binding.conversationKey,
      sessionName: binding.sessionName,
      managedProjectChannel: this.adapter.isManagedProjectChannel(thread.parentId ?? ""),
      locationLabel: `thread:${thread.id}`,
    }).join("\n");
  }

  buildProjectChannelStatus({ guildId, channelId }: { guildId: string; channelId: string }): string {
    const workspaceKey = this.buildWorkspaceKey(guildId, channelId);
    const conversationKey = this.buildConversationKeyForProjectChannel(guildId, channelId);
    return this.buildStatusLines({
      workspaceKey,
      conversationKey,
      sessionName: channelId,
      managedProjectChannel: this.adapter.isManagedProjectChannel(channelId),
      locationLabel: `project-channel:${channelId}`,
    }).join("\n");
  }

  buildGuildStatus({ guildId, channelId }: { guildId: string; channelId: string }): string {
    const isProjectChannel = this.adapter.isManagedProjectChannel(channelId);
    if (isProjectChannel) {
      return this.buildProjectChannelStatus({ guildId, channelId });
    }

    return [
      "discord-port runtime status",
      `location: guild-channel:${channelId}`,
      `managedProjectChannel: false`,
      `hostChannelId: ${this.adapter.config.hostChannelId ?? "(unresolved)"}`,
      `activeSessions: ${this.adapter.getSessionCount()}`,
      `skills: ${this.adapter.getSkillSummaries().length}`,
      "Send a message in a managed project channel to start a thread session.",
    ].join("\n");
  }

  buildDirectMessageStatus(channelId: string, username: string): string {
    const workspaceKey = this.buildWorkspaceKeyForDirectMessage(channelId);
    const conversationKey = this.buildConversationKeyForDirectMessage(channelId);
    return this.buildStatusLines({
      workspaceKey,
      conversationKey,
      sessionName: `dm-${username}`,
      managedProjectChannel: false,
      locationLabel: `dm:${channelId}`,
    }).join("\n");
  }

  getWorkspaceKeyForLocation({
    guildId,
    channelId,
    thread,
  }: {
    guildId?: string | null;
    channelId: string;
    thread?: ThreadChannel;
  }): string {
    if (!guildId) {
      return this.buildWorkspaceKeyForDirectMessage(channelId);
    }
    if (thread) {
      return this.bindThread(thread).workspaceKey;
    }
    return this.buildWorkspaceKey(guildId, channelId);
  }

  getConversationKeyForLocation({
    guildId,
    channelId,
    thread,
  }: {
    guildId?: string | null;
    channelId: string;
    thread?: ThreadChannel;
  }): string {
    if (!guildId) {
      return this.buildConversationKeyForDirectMessage(channelId);
    }
    if (thread) {
      return this.bindThread(thread).conversationKey;
    }
    return this.buildConversationKeyForProjectChannel(guildId, channelId);
  }

  getSessionNameForLocation({
    guildId,
    channelId,
    username,
    thread,
  }: {
    guildId?: string | null;
    channelId: string;
    username: string;
    thread?: ThreadChannel;
  }): string {
    if (!guildId) {
      return `dm-${username}`;
    }
    if (thread) {
      return thread.name;
    }
    return channelId;
  }

  formatAvailableSession(session: PiAvailableSessionSummary): string {
    const label = session.name?.trim() || "unnamed";
    return `${label} :: ${session.id} :: ${session.messageCount} msg :: ${session.modified.toISOString()}`;
  }

  async describeAvailableSessions(workspaceKey: string, limit: number = 10): Promise<string> {
    const sessions = await this.adapter.listSessionsForWorkspace(workspaceKey, limit);
    if (sessions.length === 0) {
      return "No resumable pi sessions found for this workspace.";
    }
    return sessions.map((session) => this.formatAvailableSession(session)).join("\n");
  }

  async findResumeChoices(workspaceKey: string, query: string, limit: number = 25): Promise<Array<{ name: string; value: string }>> {
    const normalized = query.trim().toLowerCase();
    const sessions = await this.adapter.listSessionsForWorkspace(workspaceKey, 50);
    const filtered = normalized.length === 0
      ? sessions
      : sessions.filter((session) => {
          const haystack = [session.name ?? "", session.id, session.path].join(" ").toLowerCase();
          return haystack.includes(normalized);
        });

    return filtered.slice(0, limit).map((session) => ({
      name: this.formatAvailableSession(session).slice(0, 100),
      value: session.id,
    }));
  }

  findModelChoices(workspaceKey: string, query: string, limit: number = 25): Array<{ name: string; value: string }> {
    const normalized = query.trim().toLowerCase();
    const models = this.adapter.getWorkspaceModelScope(workspaceKey).models;
    const filtered = normalized.length === 0
      ? models
      : models.filter((model) => `${model.provider}/${model.id}`.toLowerCase().includes(normalized));

    return filtered.slice(0, limit).map((model) => {
      const reference = `${model.provider}/${model.id}`;
      return {
        name: (model.name?.trim() ? `${reference} — ${model.name}` : reference).slice(0, 100),
        value: reference,
      };
    });
  }

  findProviderChoices(query: string, limit: number = 25): Array<{ name: string; value: string }> {
    const normalized = query.trim().toLowerCase();
    const providers = [...new Set(this.adapter.getAvailableModels().map((model) => model.provider))]
      .sort((left, right) => left.localeCompare(right));
    const filtered = normalized.length === 0
      ? providers
      : providers.filter((provider) => provider.toLowerCase().includes(normalized));

    return filtered.slice(0, limit).map((provider) => ({
      name: provider,
      value: provider,
    }));
  }

  findScopeModelChoices(
    workspaceKey: string,
    provider: string,
    query: string,
    limit: number = 25,
  ): {
    providerExists: boolean;
    totalMatches: number;
    truncated: boolean;
    options: Array<{ label: string; value: string; description?: string; default: boolean }>;
  } {
    const normalizedProvider = provider.trim().toLowerCase();
    const normalizedQuery = query.trim().toLowerCase();
    const available = this.adapter.getAvailableModels().filter((model) => model.provider.toLowerCase() === normalizedProvider);
    if (available.length === 0) {
      return {
        providerExists: false,
        totalMatches: 0,
        truncated: false,
        options: [],
      };
    }

    const currentScope = new Set(
      this.adapter.getWorkspaceModelScope(workspaceKey).models
        .filter((model) => model.provider.toLowerCase() === normalizedProvider)
        .map((model) => `${model.provider}/${model.id}`),
    );

    const filtered = (normalizedQuery.length === 0
      ? available
      : available.filter((model) => this.matchesModelQuery(model, normalizedQuery)))
      .sort((left, right) => {
        const leftRef = `${left.provider}/${left.id}`;
        const rightRef = `${right.provider}/${right.id}`;
        const leftSelected = currentScope.has(leftRef);
        const rightSelected = currentScope.has(rightRef);
        if (leftSelected !== rightSelected) {
          return leftSelected ? -1 : 1;
        }
        return leftRef.localeCompare(rightRef);
      });

    const options = filtered.slice(0, limit).map((model) => {
      const reference = `${model.provider}/${model.id}`;
      return {
        label: reference.slice(0, 100),
        value: reference,
        description: model.name?.trim() ? model.name.trim().slice(0, 100) : undefined,
        default: currentScope.has(reference),
      };
    });

    return {
      providerExists: true,
      totalMatches: filtered.length,
      truncated: filtered.length > limit,
      options,
    };
  }

  private matchesModelQuery(model: ModelSummary, normalizedQuery: string): boolean {
    const haystack = [model.provider, model.id, model.name ?? "", `${model.provider}/${model.id}`]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  }

  async describeManagedProjects(guild: Guild): Promise<string> {
    const managed = this.adapter.listManagedProjects();
    if (managed.length === 0) {
      return "No managed project channels yet.";
    }

    await guild.channels.fetch();
    return managed.map((workspace) => {
      const channel = guild.channels.cache.get(workspace.channelId);
      const mention = channel?.type === ChannelType.GuildText ? `<#${channel.id}>` : `#${workspace.channelId}`;
      const name = workspace.name ? ` (${workspace.name})` : "";
      return `${mention}${name} → ${workspace.root}`;
    }).join("\n");
  }

  async describeAvailableProjects(limit: number = 50): Promise<string> {
    const basePath = this.getProjectsDir();
    if (!fs.existsSync(basePath)) {
      return `Workspace base path does not exist: ${basePath}`;
    }

    const allEntries = this.listAvailableProjects();
    if (allEntries.length === 0) {
      return `No direct subfolders found under ${basePath}`;
    }

    const visibleEntries = allEntries.slice(0, limit);
    const lines = [
      `Available projects under ${basePath}`,
      "",
      ...visibleEntries.flatMap((entry) => [
        `- ${entry.name}`,
        `  path: ${entry.root}`,
        entry.managed
          ? `  status: already mapped -> <#${entry.channelId}>`
          : "  status: not mapped",
        "",
      ]),
    ];

    if (allEntries.length > visibleEntries.length) {
      lines.push(`Showing ${visibleEntries.length} of ${allEntries.length} folders.`);
    }

    return lines.join("\n").trim();
  }

  projectNameForSessionCwd(cwd: string): string {
    return path.basename(cwd);
  }
}
