import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { PicordFileConfig, PicordRuntimeConfig, ThinkingLevel, ToolMode } from "./types.js";

const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
const DEFAULT_TOOL_MODE: ToolMode = "coding";
const DEFAULT_WORKSPACE_BASE_PATH = path.join(homedir(), ".picord", "workspace");
const DEFAULT_HOST_CHANNEL_NAME = "host";

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function normalizeToolMode(value: unknown): ToolMode {
  return value === "read-only" ? "read-only" : DEFAULT_TOOL_MODE;
}

function resolvePathValue(baseDir: string, value: string): string {
  const trimmed = value.trim();
  const expanded = trimmed === "~"
    ? homedir()
    : trimmed.startsWith("~/")
      ? path.join(homedir(), trimmed.slice(2))
      : trimmed;
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function normalizeWorkspaceRoots(
  values: unknown,
  baseDir: string,
): Record<string, string> {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return {};
  }

  const entries = Object.entries(values as Record<string, unknown>)
    .filter(([key, value]) => typeof key === "string" && key.trim().length > 0 && typeof value === "string")
    .map(([key, value]) => {
      const normalizedValue = String(value).trim();
      return [key.trim(), resolvePathValue(baseDir, normalizedValue)] as const;
    })
    .filter(([, value]) => value.length > 0);

  return Object.fromEntries(entries);
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  switch (value) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "off":
      return value;
    default:
      return DEFAULT_THINKING_LEVEL;
  }
}

export function resolveConfigPath(baseDir: string, env: NodeJS.ProcessEnv): string | undefined {
  const configuredPath = env.PICORD_CONFIG?.trim();
  if (configuredPath) {
    return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(baseDir, configuredPath);
  }

  const defaultPath = path.resolve(baseDir, "picord.config.json");
  return existsSync(defaultPath) ? defaultPath : undefined;
}

export function loadFileConfig(configPath: string | undefined): PicordFileConfig {
  if (!configPath || !existsSync(configPath)) return {};

  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as PicordFileConfig;
  return parsed ?? {};
}

export function loadRuntimeConfig(
  baseDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): PicordRuntimeConfig {
  const configPath = resolveConfigPath(baseDir, env);
  const fileConfig = loadFileConfig(configPath);

  const discordToken = env.PICORD_DISCORD_TOKEN?.trim() || env.DISCORD_BOT_TOKEN?.trim();
  const discordApplicationId =
    env.PICORD_DISCORD_APPLICATION_ID?.trim() || env.DISCORD_APPLICATION_ID?.trim();

  const cwd = fileConfig.cwd ? resolvePathValue(baseDir, fileConfig.cwd) : baseDir;
  const statePath = fileConfig.statePath
    ? resolvePathValue(baseDir, fileConfig.statePath)
    : path.resolve(baseDir, "picord.state.json");
  const workspaceBasePath = fileConfig.workspaceBasePath
    ? resolvePathValue(baseDir, fileConfig.workspaceBasePath)
    : DEFAULT_WORKSPACE_BASE_PATH;

  return {
    ...fileConfig,
    discordToken,
    discordApplicationId,
    configPath,
    isActive: Boolean(discordToken),
    cwd,
    statePath,
    workspaceBasePath,
    workspaceRoots: normalizeWorkspaceRoots(fileConfig.workspaceRoots, baseDir),
    toolMode: normalizeToolMode(fileConfig.toolMode),
    allowDm: normalizeBoolean(fileConfig.allowDm, true),
    allowedGuildIds: normalizeStringArray(fileConfig.allowedGuildIds),
    allowedChannelIds: normalizeStringArray(fileConfig.allowedChannelIds),
    allowedRoleIds: normalizeStringArray(fileConfig.allowedRoleIds),
    allowedRoleNames: normalizeStringArray(fileConfig.allowedRoleNames),
    allowedUserIds: normalizeStringArray(fileConfig.allowedUserIds),
    ownerUserId: typeof fileConfig.ownerUserId === "string" ? fileConfig.ownerUserId.trim() : undefined,
    blockedPathPatterns: normalizeStringArray(fileConfig.blockedPathPatterns),
    hostChannelId:
      typeof fileConfig.hostChannelId === "string" && fileConfig.hostChannelId.trim().length > 0
        ? fileConfig.hostChannelId.trim()
        : undefined,
    hostChannelName:
      typeof fileConfig.hostChannelName === "string" && fileConfig.hostChannelName.trim().length > 0
        ? fileConfig.hostChannelName.trim().toLowerCase()
        : DEFAULT_HOST_CHANNEL_NAME,
    registerCommands: normalizeBoolean(fileConfig.registerCommands, true),
    thinkingLevel: normalizeThinkingLevel(fileConfig.thinkingLevel),
    critiqueAutoShare: normalizeBoolean(fileConfig.critiqueAutoShare, false),
    systemPromptAppend:
      typeof fileConfig.systemPromptAppend === "string" ? fileConfig.systemPromptAppend.trim() : "",
    multiAuth: fileConfig.multiAuth && typeof fileConfig.multiAuth === "object" ? fileConfig.multiAuth : {},
  };
}
