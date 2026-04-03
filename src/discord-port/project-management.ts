import fs from "node:fs";
import path from "node:path";
import type { Guild, TextChannel, User } from "discord.js";
import type { DiscordPortProjectCreationResult, DiscordPortRuntimeAdapter } from "./types.js";
import { createProjectChannel, sanitizeProjectName } from "./channel-management.js";

export async function createNewProject({
  guild,
  projectName,
  projectsDir,
  adapter,
}: {
  guild: Guild;
  projectName: string;
  projectsDir: string;
  adapter: DiscordPortRuntimeAdapter;
}): Promise<(DiscordPortProjectCreationResult & { projectDirectory: string }) | null> {
  const sanitizedName = sanitizeProjectName(projectName);
  if (!sanitizedName) {
    return null;
  }

  const projectDirectory = path.join(projectsDir, sanitizedName);
  if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
  }
  if (!fs.existsSync(projectDirectory)) {
    fs.mkdirSync(projectDirectory, { recursive: true });
  }

  const result = await createProjectChannel({
    guild,
    projectDirectory,
    adapter,
    projectName: sanitizedName,
  });

  return {
    ...result,
    projectDirectory,
  };
}

export async function addExistingProject({
  guild,
  projectDirectory,
  adapter,
  projectName,
}: {
  guild: Guild;
  projectDirectory: string;
  adapter: DiscordPortRuntimeAdapter;
  projectName?: string;
}): Promise<DiscordPortProjectCreationResult> {
  return createProjectChannel({
    guild,
    projectDirectory,
    adapter,
    projectName,
  });
}

export async function postProjectCreatedMessage({
  textChannel,
  user,
  projectDirectory,
}: {
  textChannel: TextChannel;
  user?: User;
  projectDirectory: string;
}): Promise<void> {
  await textChannel.send({
    content: [
      `🚀 **Project ready**`,
      `📁 \`${projectDirectory}\``,
      `Send a message in this channel to start a session thread.`,
      `Each thread becomes a pi session, and the thread title becomes the session name.`,
      user ? `Requested by <@${user.id}>.` : undefined,
    ].filter(Boolean).join("\n"),
    allowedMentions: { users: user ? [user.id] : [], parse: [] },
  });
}
