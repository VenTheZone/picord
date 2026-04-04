import type { Guild, Message, ThreadChannel } from "discord.js";
import type { AccessRequest, ApprovalDecisionMode } from "../access-approval.js";
import type { LiveDiscordRunRenderer } from "../live-discord-renderer.js";
import type { ModelSummary, PicordRuntimeConfig, SkillSummary, ThinkingLevel, WorkspaceInfo, WorkspaceModelScopeResult } from "../types.js";

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
  listLoginProviders(): LoginProviderOption[];
  setProviderApiKey(providerId: string, apiKey: string): void;
  startOpenAICodexLogin(userId: string): Promise<{ url: string; instructions?: string }>;
  completeOpenAICodexLogin(userId: string, codeOrUrl: string): Promise<void>;
  registerLiveRenderer(conversationKey: string, renderer: LiveDiscordRunRenderer): void;
  clearLiveRenderer(conversationKey: string): void;
  respond(options: {
    conversationKey: string;
    workspaceKey: string;
    sessionName: string;
    promptText: string;
  }): Promise<string>;
  invokeSkill(options: {
    conversationKey: string;
    workspaceKey: string;
    sessionName: string;
    skillName: string;
    args?: string;
  }): Promise<string>;
  listSkillSummaries(): SkillSummary[];
  getPendingAccessRequests(workspaceKey?: string): AccessRequest[];
  getPendingAccessRequests(workspaceKey?: string): AccessRequest[];
  resolveAccessRequest(requestId: string, mode: ApprovalDecisionMode): AccessRequest | undefined;
  abort(conversationKey: string): Promise<boolean>;
  reset(conversationKey: string): Promise<boolean>;
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
