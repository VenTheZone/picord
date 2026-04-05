import { EmbedBuilder, type ChatInputCommandInteraction, type Message } from "discord.js";
import { toDiscordChunks } from "./conversation.js";

const TOOL_FLUSH_INTERVAL_MS = 75;
const ASSISTANT_FLUSH_INTERVAL_MS = 100;
const MAX_TOOL_LINES = 12;
const MAX_FINAL_TOOL_LINES = 6;
const RESPONSE_PLACEHOLDER = "_thinking…_";

export type PiLiveUpdate =
  | { type: "assistant_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean };

interface ToolEntry {
  callId: string;
  line: string;
  status: "running" | "done" | "failed";
}

export interface LiveMessagePayload {
  content?: string;
  embeds?: EmbedBuilder[];
}

interface EditableMessageHandle {
  edit: (payload: LiveMessagePayload) => Promise<void>;
}

interface LiveMessageTarget {
  ensurePrimary: (payload: LiveMessagePayload) => Promise<EditableMessageHandle>;
  createFollowUp: (payload: LiveMessagePayload) => Promise<EditableMessageHandle>;
}

function countTripleBackticks(text: string): number {
  return (text.match(/```/g) ?? []).length;
}

function ensureClosedCodeFence(text: string): string {
  return countTripleBackticks(text) % 2 === 0 ? text : `${text}\n\`\`\``;
}

function reopenFencePrefix(source: string): string {
  const matches = [...source.matchAll(/```([^\n`]*)?/g)];
  if (matches.length === 0 || matches.length % 2 === 0) return "";
  const last = matches[matches.length - 1];
  const language = (last[1] ?? "").trim();
  return language ? `\`\`\`${language}\n` : "```\n";
}

export function normalizeDiscordText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let inCodeBlock = false;

  return lines
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        return line;
      }

      if (inCodeBlock) return line;

      if (/^#{1,6}\s+/.test(line)) {
        return `**${line.replace(/^#{1,6}\s+/, "").trim()}**`;
      }

      return line.replace(/^(\s*)[-*]\s+/u, "$1• ");
    })
    .join("\n")
    .trim();
}

export function chunkDiscordMarkdown(text: string, maxLength: number = 2000): string[] {
  const baseChunks = toDiscordChunks(text, maxLength);
  const chunks: string[] = [];
  let carryPrefix = "";

  for (const baseChunk of baseChunks) {
    const withPrefix = `${carryPrefix}${baseChunk}`;
    const closed = ensureClosedCodeFence(withPrefix).trim();
    chunks.push(closed || "Done.");
    carryPrefix = reopenFencePrefix(withPrefix);
  }

  return chunks.length > 0 ? chunks : ["Done."];
}

function summarizeValue(value: unknown, maxLength: number = 80): string | undefined {
  if (typeof value !== "string") return undefined;
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

function extractPathArg(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  return summarizeValue(record.path)
    ?? summarizeValue(record.file_path)
    ?? summarizeValue(record.file)
    ?? summarizeValue(record.target)
    ?? summarizeValue(record.symbol_id);
}

function extractCommandArg(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  return summarizeValue(record.command, 100)
    ?? summarizeValue(record.query)
    ?? summarizeValue(record.oldText, 60)
    ?? summarizeValue(record.content, 60);
}

export function formatToolCall(toolName: string, args: unknown): string {
  const path = extractPathArg(args);
  const command = extractCommandArg(args);

  if ((toolName === "read" || toolName === "edit" || toolName === "write" || toolName === "find") && path) {
    return `\`${toolName}\` "${path}"`;
  }

  if (toolName === "bash" && command) {
    return `\`bash\` "${command}"`;
  }

  if (toolName === "grep" && command) {
    return `\`grep\` "${command}"`;
  }

  if (path) {
    return `\`${toolName}\` "${path}"`;
  }

  if (command) {
    return `\`${toolName}\` "${command}"`;
  }

  return `\`${toolName}\``;
}

function formatToolLine(entry: ToolEntry): string {
  const statusIcon = entry.status === "failed" ? "❌" : entry.status === "done" ? "✅" : "🟡";
  return `${statusIcon} ${entry.line}`;
}

export function buildToolPanelContent(entries: ToolEntry[], finalized: boolean): string {
  const maxLines = finalized ? MAX_FINAL_TOOL_LINES : MAX_TOOL_LINES;
  const visibleEntries = entries.slice(-maxLines).map(formatToolLine);
  const runningCount = entries.filter((entry) => entry.status === "running").length;
  const failedCount = entries.filter((entry) => entry.status === "failed").length;

  const header = finalized ? `**Tools used · ${entries.length}**` : `**Using tools · ${entries.length}**`;
  const status = finalized
    ? failedCount > 0
      ? `_Completed with ${failedCount} failed_`
      : "_Completed_"
    : runningCount > 0
      ? `_${runningCount} running_`
      : "_Queued_";

  return [header, status, ...visibleEntries].join("\n");
}

async function createChannelHandle(
  send: (payload: LiveMessagePayload) => Promise<Message>,
  payload: LiveMessagePayload,
): Promise<EditableMessageHandle> {
  const message = await send(payload);
  return {
    edit: async (next) => {
      await message.edit({ content: next.content ?? null, embeds: next.embeds ?? [], allowedMentions: { parse: [] } });
    },
  };
}

export function createChannelLiveMessageTarget(channel: {
  send: (options: { content?: string; embeds?: EmbedBuilder[]; allowedMentions: { parse: [] } }) => Promise<Message>;
}): LiveMessageTarget {
  return {
    ensurePrimary: (payload) => createChannelHandle(
      (value) => channel.send({ content: value.content, embeds: value.embeds, allowedMentions: { parse: [] } }),
      payload,
    ),
    createFollowUp: (payload) => createChannelHandle(
      (value) => channel.send({ content: value.content, embeds: value.embeds, allowedMentions: { parse: [] } }),
      payload,
    ),
  };
}

export function createInteractionLiveMessageTarget(interaction: ChatInputCommandInteraction): LiveMessageTarget {
  let primaryInitialized = false;

  return {
    ensurePrimary: async (payload) => {
      const request = { content: payload.content, embeds: payload.embeds };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(request);
      } else {
        await interaction.reply({ ...request, ephemeral: true });
      }
      primaryInitialized = true;
      return {
        edit: async (next) => {
          await interaction.editReply({ content: next.content, embeds: next.embeds });
        },
      };
    },
    createFollowUp: async (payload) => {
      if (!primaryInitialized && !(interaction.deferred || interaction.replied)) {
        await interaction.reply({ content: payload.content, embeds: payload.embeds, ephemeral: true });
        primaryInitialized = true;
        return {
          edit: async (next) => {
            await interaction.editReply({ content: next.content, embeds: next.embeds });
          },
        };
      }

      const message = await interaction.followUp({
        content: payload.content,
        embeds: payload.embeds,
        allowedMentions: { parse: [] },
        ephemeral: true,
        fetchReply: true,
      });
      if (!("edit" in message)) {
        return { edit: async () => undefined };
      }
      return {
        edit: async (next) => {
          await message.edit({ content: next.content ?? null, embeds: next.embeds ?? [], allowedMentions: { parse: [] } });
        },
      };
    },
  };
}

export class LiveDiscordRunRenderer {
  private readonly tools: ToolEntry[] = [];
  private readonly toolIndexes = new Map<string, number>();
  private readonly assistantChunks: string[] = [];
  private toolHandle?: EditableMessageHandle;
  private assistantHandles: EditableMessageHandle[] = [];
  private toolFlushTimer?: NodeJS.Timeout;
  private assistantFlushTimer?: NodeJS.Timeout;
  private toolFlushPromise: Promise<void> = Promise.resolve();
  private assistantFlushPromise: Promise<void> = Promise.resolve();
  private finalized = false;
  private sawAssistantDelta = false;

  constructor(private readonly target: LiveMessageTarget) {}

  async onUpdate(update: PiLiveUpdate): Promise<void> {
    if (this.finalized) return;

    if (update.type === "assistant_delta") {
      if (!update.delta) return;
      this.sawAssistantDelta = true;
      this.assistantChunks.push(update.delta);
      this.scheduleAssistantFlush();
      return;
    }

    if (update.type === "tool_start") {
      if (this.toolIndexes.has(update.toolCallId)) return;
      this.toolIndexes.set(update.toolCallId, this.tools.length);
      this.tools.push({
        callId: update.toolCallId,
        line: formatToolCall(update.toolName, update.args),
        status: "running",
      });
      if (!this.sawAssistantDelta && this.assistantChunks.length === 0) {
        this.scheduleAssistantFlush();
      }
      this.scheduleToolFlush();
      return;
    }

    if (update.type === "tool_end") {
      const index = this.toolIndexes.get(update.toolCallId);
      if (index === undefined) return;
      const entry = this.tools[index];
      if (!entry) return;
      entry.status = update.isError ? "failed" : "done";
      this.scheduleToolFlush();
    }
  }

  async finalize(finalResponse: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    if (!this.sawAssistantDelta) {
      this.assistantChunks.length = 0;
      this.assistantChunks.push(finalResponse || "Done.");
    } else if (finalResponse && finalResponse !== this.assistantChunks.join("")) {
      this.assistantChunks.length = 0;
      this.assistantChunks.push(finalResponse);
    }

    for (const entry of this.tools) {
      if (entry.status === "running") entry.status = "done";
    }

    if (this.toolFlushTimer) {
      clearTimeout(this.toolFlushTimer);
      this.toolFlushTimer = undefined;
    }
    if (this.assistantFlushTimer) {
      clearTimeout(this.assistantFlushTimer);
      this.assistantFlushTimer = undefined;
    }

    await this.flushToolPanel();
    await this.flushAssistant();
  }

  private scheduleToolFlush() {
    if (this.toolFlushTimer) return;
    this.toolFlushTimer = setTimeout(() => {
      this.toolFlushTimer = undefined;
      void this.flushToolPanel();
    }, TOOL_FLUSH_INTERVAL_MS);
  }

  private scheduleAssistantFlush() {
    if (this.assistantFlushTimer) return;
    this.assistantFlushTimer = setTimeout(() => {
      this.assistantFlushTimer = undefined;
      void this.flushAssistant();
    }, ASSISTANT_FLUSH_INTERVAL_MS);
  }

  private async flushToolPanel(): Promise<void> {
    if (this.tools.length === 0) return;

    const payload: LiveMessagePayload = { content: buildToolPanelContent(this.tools, this.finalized) };
    this.toolFlushPromise = this.toolFlushPromise.then(async () => {
      if (!this.toolHandle) {
        this.toolHandle = await this.target.createFollowUp(payload);
        return;
      }
      await this.toolHandle.edit(payload);
    });
    await this.toolFlushPromise;
  }

  private async flushAssistant(): Promise<void> {
    if (this.assistantChunks.length === 0 && !this.finalized) {
      this.assistantFlushPromise = this.assistantFlushPromise.then(async () => {
        const payload = { content: RESPONSE_PLACEHOLDER };
        if (!this.assistantHandles[0]) {
          const handle = await this.target.ensurePrimary(payload);
          this.assistantHandles.push(handle);
        } else {
          await this.assistantHandles[0].edit(payload);
        }
      });
      await this.assistantFlushPromise;
      return;
    }

    const rendered = normalizeDiscordText(this.assistantChunks.join("") || "Done.");
    const chunks = chunkDiscordMarkdown(rendered);

    this.assistantFlushPromise = this.assistantFlushPromise.then(async () => {
      for (let index = 0; index < chunks.length; index++) {
        const payload = { content: chunks[index] || "Done." };
        const existing = this.assistantHandles[index];
        if (existing) {
          await existing.edit(payload);
          continue;
        }
        const handle = index === 0
          ? await this.target.ensurePrimary(payload)
          : await this.target.createFollowUp(payload);
        this.assistantHandles.push(handle);
      }
    });

    await this.assistantFlushPromise;
  }
}
