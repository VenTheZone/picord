import { ChannelType, type CategoryChannel, type Guild, type TextChannel } from "discord.js";
import path from "node:path";
import type { DiscordPortProjectCreationResult, DiscordPortRuntimeAdapter } from "./types.js";

const PICORD_CATEGORY_NAME = "Picord";

export async function ensurePicordCategory(guild: Guild): Promise<CategoryChannel> {
  await guild.channels.fetch();

  const existingCategory = guild.channels.cache.find((channel): channel is CategoryChannel => {
    return channel.type === ChannelType.GuildCategory
      && channel.name.toLowerCase() === PICORD_CATEGORY_NAME.toLowerCase();
  });

  if (existingCategory) {
    return existingCategory;
  }

  return guild.channels.create({
    name: PICORD_CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    reason: "picord managed project category",
  });
}

export function sanitizeProjectName(projectName: string): string {
  return projectName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

export async function createProjectChannel({
  guild,
  projectDirectory,
  adapter,
}: {
  guild: Guild;
  projectDirectory: string;
  adapter: DiscordPortRuntimeAdapter;
}): Promise<DiscordPortProjectCreationResult> {
  const sanitizedName = sanitizeProjectName(path.basename(projectDirectory));
  if (!sanitizedName) {
    throw new Error("Invalid project name.");
  }

  const existingManaged = adapter.listManagedProjects().find((project) => {
    return path.resolve(project.root) === path.resolve(projectDirectory) || project.name === sanitizedName;
  });
  if (existingManaged) {
    return {
      textChannelId: existingManaged.channelId,
      channelName: sanitizedName,
      projectDirectory,
      sanitizedName,
      created: false,
    };
  }

  const picordCategory = await ensurePicordCategory(guild);
  await guild.channels.fetch();

  const existingTextChannel = guild.channels.cache.find((channel): channel is TextChannel => {
    return channel.type === ChannelType.GuildText
      && channel.parentId === picordCategory.id
      && channel.name === sanitizedName;
  });
  if (existingTextChannel) {
    await adapter.addManagedProject(existingTextChannel.id, projectDirectory, sanitizedName);
    return {
      textChannelId: existingTextChannel.id,
      channelName: sanitizedName,
      projectDirectory,
      sanitizedName,
      created: false,
    };
  }

  const textChannel = await guild.channels.create({
    name: sanitizedName,
    type: ChannelType.GuildText,
    parent: picordCategory,
    topic: `picord workspace → ${projectDirectory}`,
    reason: `picord managed project for ${sanitizedName}`,
  });

  await adapter.addManagedProject(textChannel.id, projectDirectory, sanitizedName);

  return {
    textChannelId: textChannel.id,
    channelName: sanitizedName,
    projectDirectory,
    sanitizedName,
    created: true,
  };
}
