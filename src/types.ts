export type ToolMode = "read-only" | "coding";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type MultiAuthRotationMode = "round-robin" | "usage-based" | "balancer";

export interface MultiAuthPicordConfig {
  enabled?: boolean;
  debug?: boolean;
  excludeProviders?: string[];
  streamTimeouts?: {
    attemptTimeoutMs?: number;
    idleTimeoutMs?: number;
  };
  oauthRefresh?: {
    enabled?: boolean;
    safetyWindowMs?: number;
    checkIntervalMs?: number;
    maxConcurrentRefreshes?: number;
  };
  health?: {
    windowSize?: number;
    maxLatencyMs?: number;
    enabled?: boolean;
  };
  cascade?: {
    initialBackoffMs?: number;
    maxBackoffMs?: number;
    backoffMultiplier?: number;
    enabled?: boolean;
  };
}

export interface PicordFileConfig {
  allowDm?: boolean;
  cwd?: string;
  statePath?: string;
  workspaceBasePath?: string;
  workspaceRoots?: Record<string, string>;
  toolMode?: ToolMode;
  allowedGuildIds?: string[];
  allowedChannelIds?: string[];
  allowedRoleIds?: string[];
  allowedRoleNames?: string[];
  allowedUserIds?: string[];
  ownerUserId?: string;
  blockedPathPatterns?: string[];
  hostChannelId?: string;
  hostChannelName?: string;
  registerCommands?: boolean;
  thinkingLevel?: ThinkingLevel;
  modelProvider?: string;
  modelId?: string;
  critiqueAutoShare?: boolean;
  systemPromptAppend?: string;
  multiAuth?: MultiAuthPicordConfig;
}

export interface PicordRuntimeConfig extends PicordFileConfig {
  discordToken?: string;
  discordApplicationId?: string;
  configPath?: string;
  isActive: boolean;
  cwd: string;
  statePath: string;
  workspaceBasePath: string;
  workspaceRoots: Record<string, string>;
  toolMode: ToolMode;
  allowDm: boolean;
  allowedGuildIds: string[];
  allowedChannelIds: string[];
  allowedRoleIds: string[];
  allowedRoleNames: string[];
  allowedUserIds: string[];
  ownerUserId?: string;
  blockedPathPatterns: string[];
  hostChannelId?: string;
  hostChannelName: string;
  registerCommands: boolean;
  thinkingLevel: ThinkingLevel;
  critiqueAutoShare: boolean;
  systemPromptAppend: string;
  multiAuth: MultiAuthPicordConfig;
}

export interface GuildAccessInput {
  authorId: string;
  guildId: string;
  channelId: string;
  memberRoleIds: string[];
}

export interface AccessDecision {
  allowed: boolean;
  reason?: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  disableModelInvocation: boolean;
}

export interface ModelSummary {
  provider: string;
  id: string;
  name?: string;
}

export interface WorkspaceModelScopeResult {
  patterns: string[];
  models: ModelSummary[];
}

export interface WorkspaceInfo {
  root: string;
}
