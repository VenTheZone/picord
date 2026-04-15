import type { Guild, Message, ThreadChannel } from "discord.js";
import type { AccessRequest, ApprovalDecisionMode } from "../access-approval.js";
import type { LiveDiscordRunRenderer } from "../live-discord-renderer.js";
import type { CavemanLevel, ModelSummary, PicordRuntimeConfig, SkillSummary, ThinkingLevel, WorkspaceInfo, WorkspaceModelScopeResult } from "../types.js";

export interface ManagedProjectRecord {
  channelId: string;
  root: string;
  name?: string;
}

export interface LoginProviderOption {
  id: string;
  name: string;
  method: "api-key" | "oauth";
  hasStoredAuth: boolean;
  credentialCount?: number;
  supportsDiscordFlow?: boolean;
  discordFlowReason?: string;
}

export interface PiBoundSessionSummary {
  id: string;
  path?: string;
  cwd: string;
  name?: string;
}

export interface PiAvailableSessionSummary {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  modified: Date;
  messageCount: number;
}

export interface PiGlobalSessionSummary extends PiAvailableSessionSummary {
  projectName: string;
}

export interface DiscordPortProjectCreationResult {
  textChannelId: string;
  channelName: string;
  projectDirectory: string;
  sanitizedName: string;
  created: boolean;
}

export interface DiscordPortRuntimeAdapter {
  readonly config: PicordRuntimeConfig;
  isOwner(userId: string): boolean;
  listManagedProjects(): ManagedProjectRecord[];
  isManagedProjectChannel(channelId: string): boolean;
  addManagedProject(channelId: string, root: string, name?: string): Promise<ManagedProjectRecord>;
  hasBoundSession(conversationKey: string): boolean;
  getBoundSessionSummary(conversationKey: string): PiBoundSessionSummary | undefined;
  getSessionCount(): number;
  getSkillSummaries(): SkillSummary[];
  getWorkspaceModelScope(workspaceKey: string): WorkspaceModelScopeResult;
  getAvailableModels(): ModelSummary[];
  getWorkspaceInfo(workspaceKey: string): WorkspaceInfo;
  getBlockedPathPatterns(): string[];
  listSessionsForWorkspace(workspaceKey: string, limit?: number): Promise<PiAvailableSessionSummary[]>;
  listAllSessions(limit?: number): Promise<PiGlobalSessionSummary[]>;
  setWorkspaceModelScope(workspaceKey: string, rawPatterns: string): WorkspaceModelScopeResult;
  clearWorkspaceModelScope(workspaceKey: string): WorkspaceModelScopeResult;
  setWorkspaceModel(workspaceKey: string, modelReference: string): Promise<ModelSummary>;
  setConversationModel(conversationKey: string, workspaceKey: string, modelReference: string): Promise<ModelSummary>;
  getEffectiveModel(conversationKey: string, workspaceKey: string): ModelSummary | undefined;
  setWorkspaceThinkingLevel(workspaceKey: string, thinkingLevel: ThinkingLevel): void;
  setConversationThinkingLevel(conversationKey: string, workspaceKey: string, thinkingLevel: ThinkingLevel): void;
  getEffectiveThinkingLevel(conversationKey: string, workspaceKey: string): ThinkingLevel;
  setThinkingVisibility(conversationKey: string, visible: boolean): void;
  getThinkingVisibility(conversationKey: string): boolean;
  setCavemanLevel(conversationKey: string, level: CavemanLevel): void;
  getEffectiveCavemanLevel(conversationKey: string): CavemanLevel;
  listLoginProviders(): LoginProviderOption[];
  setProviderApiKey(providerId: string, apiKey: string): void;
  startProviderOAuthLogin(providerId: string, userId: string): Promise<{ url: string; instructions?: string; pendingPrompt?: { message: string; placeholder?: string; allowEmpty?: boolean } }>;
  getPendingOAuthPrompt(providerId: string, userId: string): { message: string; placeholder?: string; allowEmpty?: boolean } | undefined;
  submitProviderOAuthPrompt(providerId: string, userId: string, input: string): void;
  completeProviderOAuthLogin(providerId: string, userId: string, codeOrUrl: string): Promise<void>;
  cancelProviderOAuthLogin(userId: string): boolean;
  registerLiveRenderer(conversationKey: string, renderer: LiveDiscordRunRenderer, runId?: number): void;
  sealLiveRenderer(conversationKey: string): Promise<void>;
  clearLiveRenderer(conversationKey: string, renderer?: LiveDiscordRunRenderer): void;
  restartRuntime(options?: { notifyChannelId?: string; requestedByUserId?: string; requestedByTag?: string }): Promise<void>;
  restartSession(conversationKey: string, workspaceKey: string): Promise<boolean>;
  respond(options: {
    conversationKey: string;
    workspaceKey: string;
    sessionName: string;
    promptText: string;
    runId?: number;
  }): Promise<string>;
  invokeSkill(options: {
    conversationKey: string;
    workspaceKey: string;
    sessionName: string;
    skillName: string;
    args?: string;
    runId?: number;
  }): Promise<string>;
  listSkillSummaries(): SkillSummary[];
  getPendingAccessRequests(workspaceKey?: string): AccessRequest[];
  isOutsideWorkspaceAllowed(workspaceKey: string): boolean;
  setOutsideWorkspaceAllowed(workspaceKey: string, allowed: boolean): void;
  resolveAccessRequest(requestId: string, mode: ApprovalDecisionMode): AccessRequest | undefined;
  isStreaming(conversationKey: string): boolean;
  steer(conversationKey: string, text: string): Promise<boolean>;
  abort(conversationKey: string): Promise<boolean>;
  waitForRespondDone(conversationKey: string): Promise<void>;
  reset(conversationKey: string): Promise<boolean>;
  restartSession(conversationKey: string, workspaceKey: string): Promise<boolean>;
  compactSession(conversationKey: string, instructions?: string): Promise<boolean>;
  getAutoCompactionEnabled(conversationKey: string): boolean;
  setAutoCompactionEnabled(conversationKey: string, enabled: boolean): void;
  resumeSession(options: {
    conversationKey: string;
    workspaceKey: string;
    sessionName: string;
    sessionReference: string;
  }): Promise<PiBoundSessionSummary>;
}

export interface DiscordPortMessageFlowContext {
  guild: Guild;
  message: Message;
  projectDirectory: string;
  workspaceKey: string;
  conversationKey: string;
  sessionName: string;
}

export interface DiscordPortThreadBinding {
  thread: ThreadChannel;
  workspaceKey: string;
  conversationKey: string;
  sessionName: string;
}
