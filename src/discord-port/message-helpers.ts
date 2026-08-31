import type { ChatInputCommandInteraction, Message } from "discord.js";
import { toDiscordChunks } from "../conversation.js";

// Chunk-flood cap (hermes MAX_SPLIT_MESSAGES): one logical reply <= 8 messages.
const MAX_REPLY_CHUNKS = 8;
export function capChunks(chunks: string[]): string[] {
  if (chunks.length <= MAX_REPLY_CHUNKS) return chunks;
  const dropped = chunks.slice(MAX_REPLY_CHUNKS - 1).join("").length;
  return [
    ...chunks.slice(0, MAX_REPLY_CHUNKS - 1),
    `⚠️ Response truncated — ${dropped.toLocaleString()} chars not delivered (full text in session logs).`,
  ];
}

export function buildPromptFromMessage(message: Message, promptText: string): string {
  const attachments = [...message.attachments.values()]
    .map((attachment) => `- ${attachment.name ?? "attachment"}: ${attachment.url}`)
    .join("\n");

  return [
    "[Discord message]",
    `Author: ${message.author.tag} (${message.author.id})`,
    message.guild ? `Guild: ${message.guild.name} (${message.guild.id})` : "Guild: DM",
    `Channel: ${message.channel.id}`,
    message.channel.isThread() ? `Thread: ${message.channel.name}` : undefined,
    `Timestamp: ${message.createdAt.toISOString()}`,
    attachments ? `Attachments:\n${attachments}` : undefined,
    "",
    promptText,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function buildPromptFromInteraction(interaction: ChatInputCommandInteraction, promptText: string): string {
  return [
    "[Discord slash command]",
    `Author: ${interaction.user.tag} (${interaction.user.id})`,
    interaction.guild ? `Guild: ${interaction.guild.name} (${interaction.guild.id})` : "Guild: DM",
    `Channel: ${interaction.channelId}`,
    interaction.channel?.isThread() ? `Thread: ${interaction.channel.name}` : undefined,
    `Timestamp: ${new Date().toISOString()}`,
    "",
    promptText,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export async function sendTextResponse(
  channel: { send: (options: { content: string; allowedMentions: { parse: [] } }) => Promise<unknown> },
  content: string,
): Promise<void> {
  const chunks = capChunks(toDiscordChunks(content || "Done."));
  for (const chunk of chunks) {
    await channel.send({ content: chunk, allowedMentions: { parse: [] } });
  }
}

export async function replyToMessage(message: Message, content: string): Promise<void> {
  const chunks = capChunks(toDiscordChunks(content || "Done."));
  const [firstChunk, ...remainingChunks] = chunks;
  if (!firstChunk) {
    return;
  }

  await message.reply({
    content: firstChunk,
    allowedMentions: { parse: [], repliedUser: false },
  });

  for (const chunk of remainingChunks) {
    if ("send" in message.channel) {
      await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  }
}

export async function replyToInteraction(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  const chunks = capChunks(toDiscordChunks(content || "Done."));
  const [firstChunk, ...remainingChunks] = chunks;
  if (!firstChunk) {
    return;
  }

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(firstChunk);
  } else {
    await interaction.reply({ content: firstChunk, ephemeral: true });
  }

  for (const chunk of remainingChunks) {
    await interaction.followUp({ content: chunk, allowedMentions: { parse: [] }, ephemeral: true });
  }
}
