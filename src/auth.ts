import type { AccessDecision, GuildAccessInput, PicordRuntimeConfig } from "./types.js";

function includesId(ids: string[], value: string): boolean {
  return ids.includes(value);
}

function hasRoleMatch(allowedRoleIds: string[], memberRoleIds: string[]): boolean {
  return memberRoleIds.some((roleId) => allowedRoleIds.includes(roleId));
}

export function canAccessDm(config: PicordRuntimeConfig, authorId: string): AccessDecision {
  if (!config.allowDm) {
    return { allowed: false, reason: "DM access is disabled." };
  }

  if (config.allowedUserIds.length > 0 && !includesId(config.allowedUserIds, authorId)) {
    return { allowed: false, reason: "You are not allowlisted to use this bot in DMs." };
  }

  return { allowed: true };
}

export function canAccessGuild(
  config: PicordRuntimeConfig,
  input: GuildAccessInput,
): AccessDecision {
  if (config.allowedGuildIds.length > 0 && !includesId(config.allowedGuildIds, input.guildId)) {
    return { allowed: false, reason: "This server is not allowlisted." };
  }

  if (
    config.allowedChannelIds.length > 0 &&
    !includesId(config.allowedChannelIds, input.channelId)
  ) {
    return { allowed: false, reason: "This channel is not allowlisted." };
  }

  if (includesId(config.allowedUserIds, input.authorId)) {
    return { allowed: true };
  }

  const hasRoleRestrictions = config.allowedRoleIds.length > 0;
  const hasUserRestrictions = config.allowedUserIds.length > 0;

  if (!hasRoleRestrictions && !hasUserRestrictions) {
    return { allowed: true };
  }

  if (!hasRoleRestrictions) {
    return {
      allowed: false,
      reason: "You are not allowlisted to use this bot in this server.",
    };
  }

  if (!hasRoleMatch(config.allowedRoleIds, input.memberRoleIds)) {
    return { allowed: false, reason: "You do not have a required Discord role for this bot." };
  }

  return { allowed: true };
}
