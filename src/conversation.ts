export interface ConversationContext {
  guildId?: string | null;
  channelId: string;
  threadId?: string | null;
}

export function getConversationKey(context: ConversationContext): string {
  if (!context.guildId) {
    return `discord:dm:${context.channelId}`;
  }

  if (context.threadId) {
    return `discord:guild:${context.guildId}:thread:${context.threadId}`;
  }

  return `discord:guild:${context.guildId}:channel:${context.channelId}`;
}

export function stripBotMention(content: string, botId: string): string {
  const mentionPattern = new RegExp(`<@!?${botId}>`, "g");
  return content.replace(mentionPattern, "").trim();
}

export function toDiscordChunks(text: string, maxLength: number = 2000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const splitAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const index = splitAt > 0 ? splitAt : maxLength;
    chunks.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
