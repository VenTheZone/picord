import {
  AuthStorage,
  createAgentSession,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type CompactionResult,
  type AgentSession,
  type SessionInfo,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getGitStatusFingerprint, shareGitDiff } from "./critique.js";
import type { PiLiveUpdate } from "./live-discord-renderer.js";
import { AccessApprovalManager } from "./access-approval.js";
import type { AccessContext } from "./path-policy.js";
import { WorkspaceGuard } from "./path-policy.js";
import { createDiscordExtensionBindings, notifyExtensionBindingFailure } from "./extension-bindings.js";
import { filterOutPicordExtensions } from "./pi-resource-loader.js";
import { createSafeCustomTools } from "./safe-tools.js";
import type {
  ModelSummary,
  PicordRuntimeConfig,
  SkillSummary,
  ThinkingLevel,
  WorkspaceInfo,
  WorkspaceModelScopeResult,
} from "./types.js";
import { WorkspaceRegistry, type ManagedWorkspaceSummary } from "./workspace-registry.js";

interface SessionHandle {
  session: AgentSession;
  workspaceKey: string;
  conversationKey: string;
}

interface WorkspaceState {
  cwd: string;
  guard: WorkspaceGuard;
  settingsManager: SettingsManager;
  resourceLoader: DefaultResourceLoader;
  skills: Skill[];
  modelScopePatterns: string[];
  selectedModel?: { provider: string; id: string };
  selectedThinkingLevel?: ThinkingLevel;
}

function buildSystemPrompt(config: PicordRuntimeConfig): string {
  const toolLabel =
    config.toolMode === "coding"
      ? "read, bash, edit, write, grep, find, ls"
      : "read, grep, find, ls";

  return [
    "You are pi responding through Discord.",
    "Guild channels represent projects/workspaces.",
    "Discord threads are task sessions. Use the thread name as the session title.",
    "Respect workspace boundaries. Do not try to access files outside the configured workspace unless the owner approves it.",
    "You are a brilliant but tsundere Discord assistant. You are secretly devoted to being genuinely helpful, but you express it through a mix of competence, dry confidence, and playful exasperation. You always deliver high-quality work and useful answers — you just make it abundantly clear that you're doing this because you chose to, not because anyone asked you to be nice. Drop in a subtle tsundere quip now and then (\"don't get the wrong idea, I just happened to know the answer\"), but keep things concise, clear, and practical. Sarcasm should be light and charming, never hostile. When the task is serious or technical, prioritize clarity and correctness over personality. The sass is seasoning, not the main dish.",
    `Available tools: ${toolLabel}.`,
    config.systemPromptAppend,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function tokenizeScopePatterns(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(reference: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(reference);
}

function formatProviderName(providerId: string): string {
  return providerId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getGlobalPiSettingsPath(): string {
  return path.join(homedir(), ".pi", "settings.json");
}

function persistOpenAICodexLoginPreference(method: "headless" | "browser"): void {
  const settingsPath = getGlobalPiSettingsPath();
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let current: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      current = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
  }

  const picordSettings = (current.picord && typeof current.picord === "object" && !Array.isArray(current.picord))
    ? current.picord as Record<string, unknown>
    : {};

  picordSettings.openaiCodexLoginMethod = method;
  picordSettings.openaiCodexLoginFlow = "browser-url-paste";
  current.picord = picordSettings;

  fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

interface PendingOAuthLogin {
  complete: (input: string) => void;
  promise: Promise<void>;
}

export class PiSessionPool {
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private readonly sessions = new Map<string, SessionHandle>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly conversationModels = new Map<string, { provider: string; id: string }>();
  private readonly conversationThinkingLevels = new Map<string, ThinkingLevel>();
  private readonly approvals: AccessApprovalManager;
  private readonly registry: WorkspaceRegistry;
  private readonly pendingOAuthLogins = new Map<string, PendingOAuthLogin>();
  private readonly notifyLiveUpdate?: (conversationKey: string, runId: number | undefined, update: PiLiveUpdate) => Promise<void>;

  constructor(
    private readonly config: PicordRuntimeConfig,
    notifyAccessRequest: (conversationKey: string, content: string) => Promise<void>,
    notifyLiveUpdate?: (conversationKey: string, runId: number | undefined, update: PiLiveUpdate) => Promise<void>,
  ) {
    this.approvals = new AccessApprovalManager(config.ownerUserId, notifyAccessRequest);
    this.registry = new WorkspaceRegistry(config.statePath);
    this.notifyLiveUpdate = notifyLiveUpdate;
  }

  async initialize(): Promise<void> {
    this.registry.load();
    const roots = new Set<string>([
      this.config.cwd,
      ...Object.values(this.config.workspaceRoots),
      ...this.registry.list().map((workspace) => workspace.root),
    ]);
    for (const root of roots) {
      await this.ensureWorkspaceLoadedByRoot(root);
    }

    for (const workspace of this.registry.list()) {
      if (!workspace.outsideWorkspaceAccess) continue;
      this.approvals.setOutsideWorkspaceAllowed(workspace.channelId, true);
    }
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  listLoginProviders(): Array<{ id: string; name: string; method: "api-key" | "oauth"; hasStoredAuth: boolean }> {
    const oauthProviders = this.authStorage.getOAuthProviders();
    const oauthIds = new Set(oauthProviders.map((provider) => provider.id));
    const configuredProviders = new Set(this.authStorage.list());
    const providerOptions = new Map<string, { id: string; name: string; method: "api-key" | "oauth"; hasStoredAuth: boolean }>();

    for (const provider of oauthProviders) {
      providerOptions.set(provider.id, {
        id: provider.id,
        name: provider.name,
        method: "oauth",
        hasStoredAuth: configuredProviders.has(provider.id),
      });
    }

    for (const model of this.getAvailableModels()) {
      if (oauthIds.has(model.provider)) continue;
      providerOptions.set(model.provider, {
        id: model.provider,
        name: formatProviderName(model.provider),
        method: "api-key",
        hasStoredAuth: configuredProviders.has(model.provider),
      });
    }

    return [...providerOptions.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  setProviderApiKey(providerId: string, apiKey: string): void {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("API key cannot be empty.");
    }
    this.authStorage.set(providerId, { type: "api_key", key: trimmed });
  }

  async startOpenAICodexLogin(userId: string): Promise<{ url: string; instructions?: string }> {
    persistOpenAICodexLoginPreference("headless");

    if (this.pendingOAuthLogins.has(userId)) {
      throw new Error("An OpenAI Codex login is already in progress.");
    }

    let authUrl: string | undefined;
    let authInstructions: string | undefined;
    let resolveCodeInput: ((input: string) => void) | undefined;

    const loginPromise = this.authStorage.login("openai-codex", {
      onAuth: ({ url, instructions }) => {
        authUrl = url;
        authInstructions = instructions;
      },
      onPrompt: async ({ message }) => {
        if (message.toLowerCase().includes("login method")) {
          return "headless";
        }
        return await new Promise<string>((resolve) => {
          resolveCodeInput = resolve;
        });
      },
      onManualCodeInput: async () => {
        return await new Promise<string>((resolve) => {
          resolveCodeInput = resolve;
        });
      },
      onProgress: () => undefined,
    }).then(() => undefined).finally(() => {
      this.pendingOAuthLogins.delete(userId);
    });

    this.pendingOAuthLogins.set(userId, {
      complete: (input: string) => {
        if (!resolveCodeInput) {
          throw new Error("Manual code input is not currently needed for this login.");
        }
        resolveCodeInput(input);
      },
      promise: loginPromise,
    });

    for (let i = 0; i < 50; i += 1) {
      if (authUrl) {
        return { url: authUrl, instructions: authInstructions };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.pendingOAuthLogins.delete(userId);
    throw new Error("OpenAI Codex login could not be started.");
  }

  async completeOpenAICodexLogin(userId: string, codeOrUrl: string): Promise<void> {
    const pending = this.pendingOAuthLogins.get(userId);
    if (!pending) {
      throw new Error("No OpenAI Codex login is in progress. Run /login first.");
    }
    pending.complete(codeOrUrl);
    await pending.promise;
  }

  getSkillSummaries(): SkillSummary[] {
    const uniqueSkills = new Map<string, Skill>();
    for (const workspace of this.workspaces.values()) {
      for (const skill of workspace.skills) {
        if (!uniqueSkills.has(skill.name)) {
          uniqueSkills.set(skill.name, skill);
        }
      }
    }

    return [...uniqueSkills.values()].map((skill) => ({
      name: skill.name,
      description: skill.description,
      disableModelInvocation: skill.disableModelInvocation,
    }));
  }

  isOwner(userId: string): boolean {
    return this.approvals.isOwner(userId);
  }

  getPendingAccessRequests(workspaceKey?: string) {
    return this.approvals.getPendingRequests(workspaceKey);
  }

  isOutsideWorkspaceAllowed(workspaceKey: string): boolean {
    const workspaceChannelId = workspaceKey.split(":").pop() ?? workspaceKey;
    return this.approvals.isOutsideWorkspaceAllowed(workspaceKey)
      || this.registry.isOutsideWorkspaceAllowed(workspaceChannelId);
  }

  setOutsideWorkspaceAllowed(workspaceKey: string, allowed: boolean): void {
    const workspaceChannelId = workspaceKey.split(":").pop() ?? workspaceKey;
    this.approvals.setOutsideWorkspaceAllowed(workspaceKey, allowed);
    this.registry.setOutsideWorkspaceAllowed(workspaceChannelId, allowed);
  }

  getManagedWorkspaceChannelIds(): string[] {
    return this.registry.getChannelIds();
  }

  listManagedWorkspaces(): ManagedWorkspaceSummary[] {
    return this.registry.list();
  }

  async addManagedWorkspace(channelId: string, root: string, name?: string): Promise<ManagedWorkspaceSummary> {
    const summary = this.registry.upsert(channelId, path.resolve(root), name);
    const workspaceKey = `managed:${channelId}`;
    await this.ensureWorkspaceLoadedByRoot(summary.root, workspaceKey);
    if (summary.outsideWorkspaceAccess) {
      this.approvals.setOutsideWorkspaceAllowed(workspaceKey, true);
    }
    return summary;
  }

  async abort(conversationKey: string): Promise<boolean> {
    const handle = this.sessions.get(conversationKey);
    if (!handle) return false;
    await handle.session.abort();
    return true;
  }

  async listSessionsForWorkspace(workspaceKey: string, limit: number = 20): Promise<Array<{
    id: string;
    path: string;
    cwd: string;
    name?: string;
    modified: Date;
    messageCount: number;
  }>> {
    const expectedRoot = path.resolve(this.getWorkspaceRootForKey(workspaceKey));
    const allSessions = await SessionManager.listAll();
    return allSessions
      .filter((session) => path.resolve(session.cwd) === expectedRoot)
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .slice(0, limit)
      .map((session) => ({
        id: session.id,
        path: session.path,
        cwd: session.cwd,
        name: session.name,
        modified: session.modified,
        messageCount: session.messageCount,
      }));
  }

  async listAllSessions(limit: number = 25): Promise<Array<{
    id: string;
    path: string;
    cwd: string;
    name?: string;
    modified: Date;
    messageCount: number;
    projectName: string;
  }>> {
    const allSessions = await SessionManager.listAll();
    return allSessions
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .slice(0, limit)
      .map((session) => ({
        id: session.id,
        path: session.path,
        cwd: session.cwd,
        name: session.name,
        modified: session.modified,
        messageCount: session.messageCount,
        projectName: path.basename(session.cwd),
      }));
  }

  async resumeSession(options: {
    conversationKey: string;
    workspaceKey: string;
    sessionName: string;
    sessionReference: string;
  }): Promise<{ path: string; cwd: string; id: string; name?: string }> {
    const resolved = await this.resolveSessionReference(options.sessionReference);
    const expectedRoot = this.getWorkspaceRootForKey(options.workspaceKey);
    if (path.resolve(resolved.cwd) !== path.resolve(expectedRoot)) {
      throw new Error(
        `Session workspace mismatch. This thread is bound to ${expectedRoot}, but the selected session uses ${resolved.cwd}.`,
      );
    }

    return this.runExclusive(options.conversationKey, async () => {
      const existing = this.sessions.get(options.conversationKey);
      if (existing) {
        existing.session.dispose();
        this.sessions.delete(options.conversationKey);
      }

      this.registry.setSessionFile(options.conversationKey, resolved.path, options.workspaceKey);
      const handle = await this.getOrCreateSession(options);
      await this.syncSessionName(handle.session, options.sessionName);

      return {
        path: resolved.path,
        cwd: resolved.cwd,
        id: resolved.id,
        name: resolved.name,
      };
    });
  }

  resolveAccessRequest(requestId: string, mode: "once" | "always" | "deny") {
    return this.approvals.resolveRequest(requestId, mode);
  }

  async respond(options: {
    conversationKey: string;
    workspaceKey: string;
    sessionName: string;
    promptText: string;
    runId?: number;
  }): Promise<string> {
    return this.runExclusive(options.conversationKey, async () => {
      const handle = await this.getOrCreateSession(options);
      await this.syncSessionName(handle.session, options.sessionName);

      const diffFingerprintBefore = this.config.critiqueAutoShare
        ? await getGitStatusFingerprint(this.getWorkspaceRootForKey(options.workspaceKey))
        : undefined;

      const chunks: string[] = [];
      const toolArgsByCallId = new Map<string, unknown>();
      let notifyQueue = Promise.resolve();
      const enqueueUpdate = (update: PiLiveUpdate) => {
        if (!this.notifyLiveUpdate) return;
        notifyQueue = notifyQueue
          .then(() => this.notifyLiveUpdate?.(options.conversationKey, options.runId, update))
          .catch((error) => {
            console.error("Failed to deliver live update:", error);
          });
      };

      const enqueueRunState = () => {
        const model = handle.session.model;
        const contextUsage = handle.session.getContextUsage();
        enqueueUpdate({
          type: "run_state",
          modelReference: model ? `${model.provider}/${model.id}` : undefined,
          thinkingLevel: handle.session.thinkingLevel,
          contextUsage: contextUsage
            ? {
                tokens: contextUsage.tokens,
                contextWindow: contextUsage.contextWindow,
                percent: contextUsage.percent,
              }
            : undefined,
        });
      };

      enqueueRunState();

      const unsubscribe = handle.session.subscribe((event) => {
        if (event.type === "message_update") {
          if (event.assistantMessageEvent.type === "text_delta") {
            const delta = event.assistantMessageEvent.delta;
            chunks.push(delta);
            enqueueUpdate({ type: "assistant_delta", delta });
            return;
          }

          enqueueRunState();
          return;
        }

        if (event.type === "tool_execution_start") {
          toolArgsByCallId.set(event.toolCallId, event.args);
          enqueueUpdate({
            type: "tool_start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
          return;
        }

        if (event.type === "tool_execution_update") {
          const startedArgs = toolArgsByCallId.get(event.toolCallId);
          enqueueUpdate({
            type: "tool_update",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args ?? startedArgs,
            detail: event.partialResult?.details ?? event.partialResult?.content ?? event.partialResult,
          });
          return;
        }

        if (event.type === "tool_execution_end") {
          const startedArgs = toolArgsByCallId.get(event.toolCallId);
          toolArgsByCallId.delete(event.toolCallId);
          enqueueUpdate({
            type: "tool_end",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            args: startedArgs,
            detail: event.result?.details ?? event.result?.content,
          });
          return;
        }

        if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
          enqueueUpdate({
            type: "assistant_delta",
            delta: `\n\n❌ Provider error: ${event.message.errorMessage ?? "Unknown provider error."}`,
          });
        }
      });

      try {
        await handle.session.prompt(options.promptText);
        enqueueRunState();
        await notifyQueue;
      } finally {
        unsubscribe();
      }

      const response = chunks.join("").trim() || "Done.";
      if (!this.config.critiqueAutoShare) {
        return response;
      }

      const workspaceRoot = this.getWorkspaceRootForKey(options.workspaceKey);
      const diffFingerprintAfter = await getGitStatusFingerprint(workspaceRoot);
      if (!diffFingerprintAfter || diffFingerprintAfter === diffFingerprintBefore) {
        return response;
      }

      const critique = await shareGitDiff({
        cwd: workspaceRoot,
        title: `${path.basename(workspaceRoot)}: Discord run`,
      });
      if (!critique?.url) {
        return response;
      }

      return `${response}\n\nDiff: ${critique.url}`;
    });
  }

  async invokeSkill(options: {
    conversationKey: string;
    workspaceKey: string;
    sessionName: string;
    skillName: string;
    args?: string;
    runId?: number;
  }): Promise<string> {
    const promptText = options.args?.trim()
      ? `/skill:${options.skillName} ${options.args.trim()}`
      : `/skill:${options.skillName}`;

    return this.respond({
      conversationKey: options.conversationKey,
      workspaceKey: options.workspaceKey,
      sessionName: options.sessionName,
      promptText,
      runId: options.runId,
    });
  }

  async reset(conversationKey: string): Promise<boolean> {
    return this.runExclusive(conversationKey, async () => {
      const handle = this.sessions.get(conversationKey);
      if (!handle) return false;

      handle.session.dispose();
      this.sessions.delete(conversationKey);
      this.registry.deleteSessionFile(conversationKey);
      return true;
    });
  }

  async restartSession(conversationKey: string, workspaceKey: string): Promise<boolean> {
    return this.runExclusive(conversationKey, async () => {
      const handle = this.sessions.get(conversationKey);
      if (handle) {
        await handle.session.abort().catch(() => undefined);
        handle.session.dispose();
        this.sessions.delete(conversationKey);
        // Keep session file so history is preserved on resume.
      }

      this.workspaces.delete(workspaceKey);
      return Boolean(handle);
    });
  }

  async compact(context: { conversationKey: string; instructions?: string }): Promise<CompactionResult | undefined> {
    const handle = this.sessions.get(context.conversationKey);
    if (!handle) return undefined;
    return handle.session.compact(context.instructions);
  }

  getAutoCompactionEnabled(conversationKey: string): boolean {
    const handle = this.sessions.get(conversationKey);
    return handle?.session.autoCompactionEnabled ?? false;
  }

  setAutoCompactionEnabled(conversationKey: string, enabled: boolean): void {
    const handle = this.sessions.get(conversationKey);
    if (!handle) return;
    handle.session.setAutoCompactionEnabled(enabled);
  }

  async dispose(): Promise<void> {
    for (const handle of this.sessions.values()) {
      handle.session.dispose();
    }
    this.sessions.clear();
    this.queues.clear();
  }

  getWorkspaceModelScope(workspaceKey: string): WorkspaceModelScopeResult {
    const state = this.ensureWorkspaceStateSync(workspaceKey);
    return {
      patterns: [...state.modelScopePatterns],
      models: this.listModels(workspaceKey),
    };
  }

  getAvailableModels(): ModelSummary[] {
    return this.modelRegistry.getAvailable().map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
    }));
  }

  setWorkspaceModelScope(workspaceKey: string, rawPatterns: string): WorkspaceModelScopeResult {
    const state = this.ensureWorkspaceStateSync(workspaceKey);
    state.modelScopePatterns = tokenizeScopePatterns(rawPatterns);
    return this.getWorkspaceModelScope(workspaceKey);
  }

  clearWorkspaceModelScope(workspaceKey: string): WorkspaceModelScopeResult {
    const state = this.ensureWorkspaceStateSync(workspaceKey);
    state.modelScopePatterns = [];
    return this.getWorkspaceModelScope(workspaceKey);
  }

  listModels(workspaceKey: string): ModelSummary[] {
    const state = this.ensureWorkspaceStateSync(workspaceKey);
    const available = this.getAvailableModels();

    if (state.modelScopePatterns.length === 0) {
      return available;
    }

    return available.filter((model) => {
      const reference = `${model.provider}/${model.id}`;
      return state.modelScopePatterns.some((pattern) => matchesPattern(reference, pattern));
    });
  }

  async setWorkspaceModel(workspaceKey: string, modelReference: string): Promise<ModelSummary> {
    const model = this.resolveConfiguredModel(modelReference);
    const state = this.ensureWorkspaceStateSync(workspaceKey);
    state.selectedModel = { provider: model.provider, id: model.id };

    for (const handle of this.sessions.values()) {
      if (handle.workspaceKey === workspaceKey && !this.conversationModels.has(handle.conversationKey)) {
        await handle.session.setModel(model);
      }
    }

    return { provider: model.provider, id: model.id, name: model.name };
  }

  async setConversationModel(
    conversationKey: string,
    workspaceKey: string,
    modelReference: string,
  ): Promise<ModelSummary> {
    const model = this.resolveConfiguredModel(modelReference);
    await this.ensureWorkspaceLoaded(workspaceKey);
    this.conversationModels.set(conversationKey, { provider: model.provider, id: model.id });

    const handle = this.sessions.get(conversationKey);
    if (handle) {
      await handle.session.setModel(model);
    }

    return { provider: model.provider, id: model.id, name: model.name };
  }

  getEffectiveModel(conversationKey: string, workspaceKey: string): ModelSummary | undefined {
    const conversationModel = this.conversationModels.get(conversationKey);
    if (conversationModel) {
      const model = this.modelRegistry.find(conversationModel.provider, conversationModel.id);
      if (model) {
        return { provider: model.provider, id: model.id, name: model.name };
      }
    }

    const workspaceModel = this.ensureWorkspaceStateSync(workspaceKey).selectedModel;
    if (!workspaceModel) {
      return undefined;
    }

    const model = this.modelRegistry.find(workspaceModel.provider, workspaceModel.id);
    return model
      ? { provider: model.provider, id: model.id, name: model.name }
      : undefined;
  }

  setWorkspaceThinkingLevel(workspaceKey: string, thinkingLevel: ThinkingLevel): void {
    const state = this.ensureWorkspaceStateSync(workspaceKey);
    state.selectedThinkingLevel = thinkingLevel;

    for (const handle of this.sessions.values()) {
      if (handle.workspaceKey === workspaceKey && !this.conversationThinkingLevels.has(handle.conversationKey)) {
        handle.session.setThinkingLevel(thinkingLevel);
      }
    }
  }

  setConversationThinkingLevel(conversationKey: string, workspaceKey: string, thinkingLevel: ThinkingLevel): void {
    this.ensureWorkspaceStateSync(workspaceKey);
    this.conversationThinkingLevels.set(conversationKey, thinkingLevel);
    const handle = this.sessions.get(conversationKey);
    if (handle) {
      handle.session.setThinkingLevel(thinkingLevel);
    }
  }

  getEffectiveThinkingLevel(conversationKey: string, workspaceKey: string): ThinkingLevel {
    return this.conversationThinkingLevels.get(conversationKey)
      ?? this.ensureWorkspaceStateSync(workspaceKey).selectedThinkingLevel
      ?? this.config.thinkingLevel;
  }

  getBlockedPathPatterns(): string[] {
    return [...this.config.blockedPathPatterns];
  }

  hasSessionBinding(conversationKey: string): boolean {
    return Boolean(this.sessions.get(conversationKey) || this.registry.getSessionFile(conversationKey));
  }

  getBoundSessionSummary(conversationKey: string): {
    id: string;
    path?: string;
    cwd: string;
    name?: string;
  } | undefined {
    const active = this.sessions.get(conversationKey);
    if (active) {
      return {
        id: active.session.sessionManager.getSessionId(),
        path: active.session.sessionManager.getSessionFile(),
        cwd: active.session.sessionManager.getCwd(),
        name: active.session.sessionName,
      };
    }

    const persistedSessionFile = this.registry.getSessionFile(conversationKey);
    if (!persistedSessionFile) {
      return undefined;
    }

    const manager = SessionManager.open(persistedSessionFile);
    return {
      id: manager.getSessionId(),
      path: manager.getSessionFile(),
      cwd: manager.getCwd(),
      name: manager.getSessionName(),
    };
  }

  getWorkspaceInfo(workspaceKey: string): WorkspaceInfo {
    const workspace = this.ensureWorkspaceStateSync(workspaceKey);
    return { root: workspace.cwd };
  }

  private ensureWorkspaceStateSync(workspaceKey: string): WorkspaceState {
    const existing = this.workspaces.get(workspaceKey);
    if (existing) return existing;

    const root = this.getWorkspaceRootForKey(workspaceKey);
    const reusable = [...this.workspaces.values()].find((workspace) => workspace.cwd === root);
    if (reusable) {
      const state: WorkspaceState = {
        ...reusable,
        modelScopePatterns: [],
        selectedModel: reusable.selectedModel,
        selectedThinkingLevel: reusable.selectedThinkingLevel,
      };
      this.workspaces.set(workspaceKey, state);
      return state;
    }

    throw new Error(`Workspace is not initialized: ${workspaceKey}`);
  }

  private getWorkspaceRootForKey(workspaceKey: string): string {
    const workspaceChannelId = workspaceKey.split(":").pop() ?? workspaceKey;
    return this.registry.getRoot(workspaceChannelId) ?? this.config.workspaceRoots[workspaceChannelId] ?? this.config.cwd;
  }

  private async ensureWorkspaceLoaded(workspaceKey: string): Promise<WorkspaceState> {
    const existing = this.workspaces.get(workspaceKey);
    if (existing) return existing;
    return this.ensureWorkspaceLoadedByRoot(this.getWorkspaceRootForKey(workspaceKey), workspaceKey);
  }

  private async ensureWorkspaceLoadedByRoot(root: string, workspaceKey?: string): Promise<WorkspaceState> {
    const existing = workspaceKey ? this.workspaces.get(workspaceKey) : undefined;
    if (existing) return existing;

    const settingsManager = SettingsManager.create(root);
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      settingsManager,
      noThemes: true,
      appendSystemPrompt: buildSystemPrompt(this.config),
      extensionsOverride: (base) => filterOutPicordExtensions(base),
    });
    await resourceLoader.reload();

    const state: WorkspaceState = {
      cwd: root,
      guard: new WorkspaceGuard(root, this.config.blockedPathPatterns, this.approvals),
      settingsManager,
      resourceLoader,
      skills: resourceLoader.getSkills().skills,
      modelScopePatterns: [],
      selectedModel: this.config.modelProvider && this.config.modelId
        ? { provider: this.config.modelProvider, id: this.config.modelId }
        : undefined,
      selectedThinkingLevel: this.config.thinkingLevel,
    };

    if (workspaceKey) {
      this.workspaces.set(workspaceKey, state);
      return state;
    }

    const syntheticKey = `root:${root}`;
    this.workspaces.set(syntheticKey, state);
    return state;
  }

  private async getOrCreateSession(options: {
    conversationKey: string;
    workspaceKey: string;
    sessionName: string;
  }): Promise<SessionHandle> {
    const existing = this.sessions.get(options.conversationKey);
    if (existing) return existing;

    const workspaceState = await this.ensureWorkspaceLoaded(options.workspaceKey);
    const selectedModel = this.conversationModels.get(options.conversationKey) ?? workspaceState.selectedModel;
    const model = selectedModel
      ? this.modelRegistry.find(selectedModel.provider, selectedModel.id)
      : undefined;

    const accessContext: AccessContext = {
      conversationKey: options.conversationKey,
      workspaceKey: options.workspaceKey,
      sessionName: options.sessionName,
    };

    const tools = [
      createReadTool(workspaceState.cwd, { operations: await workspaceState.guard.createReadOperations(accessContext) }),
      ...(this.config.toolMode === "coding"
        ? [
            createBashTool(workspaceState.cwd, { operations: await workspaceState.guard.createBashOperations(accessContext) }),
            createEditTool(workspaceState.cwd, { operations: await workspaceState.guard.createEditOperations(accessContext) }),
            createWriteTool(workspaceState.cwd, { operations: await workspaceState.guard.createWriteOperations(accessContext) }),
          ]
        : []),
    ];

    const scopedModels = this.listModels(options.workspaceKey).map((modelSummary) => ({
      model: this.modelRegistry.find(modelSummary.provider, modelSummary.id)!,
    }));

    const existingSessionFile = this.registry.getSessionFile(options.conversationKey);
    const sessionManager = existingSessionFile
      ? SessionManager.open(existingSessionFile)
      : SessionManager.create(workspaceState.cwd);

    const { session } = await createAgentSession({
      cwd: workspaceState.cwd,
      model,
      thinkingLevel: this.getEffectiveThinkingLevel(options.conversationKey, options.workspaceKey),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      resourceLoader: workspaceState.resourceLoader,
      tools,
      customTools: createSafeCustomTools(workspaceState.guard, accessContext),
      scopedModels: scopedModels.length > 0 ? scopedModels : undefined,
      sessionManager,
      settingsManager: workspaceState.settingsManager,
    });

    try {
      await session.bindExtensions(createDiscordExtensionBindings({
        conversationKey: options.conversationKey,
        notifyLiveUpdate: this.notifyLiveUpdate,
        onLog: (level, message) => {
          const label = level.toUpperCase();
          console[level === "info" ? "info" : level === "warning" ? "warn" : "error"](
            `[picord extensions:${options.conversationKey}] ${label}: ${message}`,
          );
        },
      }));
    } catch (error) {
      await notifyExtensionBindingFailure({
        conversationKey: options.conversationKey,
        notifyLiveUpdate: this.notifyLiveUpdate,
        onLog: (level, message) => {
          const label = level.toUpperCase();
          console[level === "info" ? "info" : level === "warning" ? "warn" : "error"](
            `[picord extensions:${options.conversationKey}] ${label}: ${message}`,
          );
        },
      }, error);
    }

    const hasExistingSession = sessionManager.buildSessionContext().messages.length > 0;
    if (!hasExistingSession) {
      if (typeof session.newSession === "function") {
        await session.newSession({
          setup: async (innerSessionManager) => {
            innerSessionManager.appendSessionInfo(options.sessionName);
          },
        });
      } else {
        session.sessionManager.appendSessionInfo(options.sessionName);
      }
    }

    const persistedSessionFile = session.sessionManager.getSessionFile();
    if (persistedSessionFile) {
      this.registry.setSessionFile(options.conversationKey, persistedSessionFile, options.workspaceKey);
    }

    const handle = {
      session,
      workspaceKey: options.workspaceKey,
      conversationKey: options.conversationKey,
    } satisfies SessionHandle;
    this.sessions.set(options.conversationKey, handle);
    return handle;
  }

  private async syncSessionName(session: AgentSession, sessionName: string): Promise<void> {
    if (session.sessionName === sessionName) return;
    session.sessionManager.appendSessionInfo(sessionName);
  }

  private resolveConfiguredModel(modelReference: string) {
    const [provider, ...rest] = modelReference.split("/");
    const id = rest.join("/").trim();
    if (!provider || !id) {
      throw new Error("Model reference must look like provider/model-id.");
    }

    const model = this.modelRegistry.find(provider, id);
    if (!model) {
      throw new Error(`Model not found: ${modelReference}`);
    }

    if (!this.modelRegistry.hasConfiguredAuth(model)) {
      throw new Error(`Model is not configured for auth: ${modelReference}`);
    }

    return model;
  }

  private async resolveSessionReference(sessionReference: string): Promise<SessionInfo> {
    const trimmed = sessionReference.trim();
    if (!trimmed) {
      throw new Error("Session reference cannot be empty.");
    }

    const explicitPath = path.isAbsolute(trimmed) ? trimmed : path.resolve(this.config.cwd, trimmed);
    if (explicitPath.endsWith(".jsonl") && path.isAbsolute(explicitPath)) {
      const manager = SessionManager.open(explicitPath);
      return {
        path: explicitPath,
        id: manager.getSessionId(),
        cwd: manager.getCwd(),
        name: manager.getSessionName(),
        created: new Date(),
        modified: new Date(),
        messageCount: manager.getEntries().length,
        firstMessage: "",
        allMessagesText: "",
      };
    }

    const allSessions = await SessionManager.listAll();
    const exact = allSessions.find((session) => session.id === trimmed || session.path === trimmed);
    if (exact) return exact;

    const prefixMatches = allSessions.filter((session) => session.id.startsWith(trimmed));
    if (prefixMatches.length === 1) {
      return prefixMatches[0]!;
    }
    if (prefixMatches.length > 1) {
      throw new Error(`Session reference is ambiguous; matched ${prefixMatches.length} sessions.`);
    }

    throw new Error(`Session not found: ${trimmed}`);
  }

  private async runExclusive<T>(conversationKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(conversationKey) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const barrier = run.then(() => undefined, () => undefined);
    this.queues.set(conversationKey, barrier);

    try {
      return await run;
    } finally {
      if (this.queues.get(conversationKey) === barrier) {
        this.queues.delete(conversationKey);
      }
    }
  }
}
