import type { Guild, Message, ThreadChannel } from "discord.js";
import type { AccessRequest, ApprovalDecisionMode } from "../access-approval.js";
import type { ModelSummary, PicordRuntimeConfig, SkillSummary, WorkspaceInfo, WorkspaceModelScopeResult } from "../types.js";

export interface ManagedProjectRecord {
  channelId: string;
  root: string;
  name?: string;
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
  setWorkspaceModelScope(workspaceKey: string, rawPatterns: string): WorkspaceModelScopeResult;
  clearWorkspaceModelScope(workspaceKey: string): WorkspaceModelScopeResult;
  setWorkspaceModel(workspaceKey: string, modelReference: string): Promise<ModelSummary>;
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
