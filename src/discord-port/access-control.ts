import { GuildMember, type Guild, type Interaction, type Message } from "discord.js";
import { canAccessDm, canAccessGuild } from "../auth.js";
import type { PicordRuntimeConfig } from "../types.js";
import type { DiscordPortRuntimeAdapter } from "./types.js";

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function getWorkspaceChannelIdFromMessage(message: Message): string {
  return message.channel?.isThread() ? (message.channel.parentId ?? message.channelId) : message.channelId;
}

export function getWorkspaceChannelIdFromInteraction(interaction: Interaction & { channelId: string; channel?: { isThread?: () => boolean; parentId?: string | null } | null }): string {
  return interaction.channel?.isThread?.() ? (interaction.channel.parentId ?? interaction.channelId) : interaction.channelId;
}

export function extractMemberRoleIds(member: Message["member"] | { roles?: string[] } | null | undefined): string[] {
  if (!member) {
    return [];
  }

  if (member instanceof GuildMember) {
    return [...member.roles.cache.keys()];
  }

  if (typeof member === "object" && member !== null && "roles" in member && Array.isArray(member.roles)) {
    return member.roles.filter((roleId): roleId is string => typeof roleId === "string");
  }

  return [];
}

async function resolveAllowedRoleIds(config: PicordRuntimeConfig, guild: Guild | null): Promise<string[]> {
  const roleIds = [...config.allowedRoleIds];
  if (!guild || config.allowedRoleNames.length === 0) {
    return unique(roleIds);
  }

  await guild.roles.fetch();
  for (const roleName of config.allowedRoleNames) {
    const matched = guild.roles.cache.find((role) => role.name === roleName);
    if (matched) {
      roleIds.push(matched.id);
    }
  }

  return unique(roleIds);
}

export async function buildEffectiveAccessConfig(
  config: PicordRuntimeConfig,
  adapter: DiscordPortRuntimeAdapter,
  guild: Guild | null,
): Promise<PicordRuntimeConfig> {
  return {
    ...config,
    allowedUserIds: unique([
      ...config.allowedUserIds,
      ...(config.ownerUserId ? [config.ownerUserId] : []),
    ]),
    allowedChannelIds: unique([
      ...config.allowedChannelIds,
      ...Object.keys(config.workspaceRoots),
      ...adapter.listManagedProjects().map((project) => project.channelId),
      ...(config.hostChannelId ? [config.hostChannelId] : []),
    ]),
    allowedRoleIds: await resolveAllowedRoleIds(config, guild),
  };
}

export async function canAccessDiscordMessage(
  config: PicordRuntimeConfig,
  adapter: DiscordPortRuntimeAdapter,
  message: Message,
) {
  if (!message.inGuild()) {
    return canAccessDm(config, message.author.id);
  }

  const effectiveConfig = await buildEffectiveAccessConfig(config, adapter, message.guild);
  return canAccessGuild(effectiveConfig, {
    authorId: message.author.id,
    guildId: message.guildId!,
    channelId: getWorkspaceChannelIdFromMessage(message),
    memberRoleIds: extractMemberRoleIds(message.member),
  });
}
