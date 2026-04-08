import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, type ChatInputCommandInteraction, type Message } from "discord.js";
import { toDiscordChunks } from "./conversation.js";

const FLUSH_INTERVAL_MS = 75;
const RESPONSE_PLACEHOLDER = "_thinking…_";

export type PiLiveUpdate =
  | { type: "assistant_delta"; delta: string }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_end" }
  | { type: "run_state"; modelReference?: string; thinkingLevel?: string; contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; args?: unknown; detail?: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; args?: unknown; detail?: unknown };

interface ToolEntry {
  callId: string;
  toolName: string;
  line: string;
  status: "running" | "done" | "failed";
  args?: unknown;
  detail?: string;
  outputDetail?: unknown;
}

interface AssistantEntry {
  kind: "assistant";
  text: string;
}

interface ThinkingEntry {
  kind: "thinking";
  text: string;
}

interface ToolTimelineEntry {
  kind: "tool";
  tool: ToolEntry;
}

type TimelineEntry = AssistantEntry | ThinkingEntry | ToolTimelineEntry;

export interface LiveMessagePayload {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>>;
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
    ?? summarizeValue(record.symbol_id)
    ?? summarizeValue(record.cwd);
}

function extractCommandArg(args: unknown): string | undefined {
  if (typeof args === "string") return summarizeValue(args, 100);
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  return summarizeValue(record.command, 100)
    ?? summarizeValue(record.pattern, 100)
    ?? summarizeValue(record.query)
    ?? summarizeValue(record.oldText, 60)
    ?? summarizeValue(record.content, 100)
    ?? summarizeValue(record.error, 100)
    ?? summarizeValue(record.stderr, 100)
    ?? summarizeValue(record.stdout, 100);
}

function formatEditDelta(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const edits = Array.isArray(record.edits) ? record.edits : undefined;
  if (!edits || edits.length === 0) return undefined;

  let added = 0;
  let removed = 0;
  for (const entry of edits) {
    if (!entry || typeof entry !== "object") continue;
    const editEntry = entry as Record<string, unknown>;
    const oldText = typeof editEntry.oldText === "string" ? editEntry.oldText : "";
    const newText = typeof editEntry.newText === "string" ? editEntry.newText : "";
    const oldLines = oldText.length === 0 ? 0 : oldText.split("\n").length;
    const newLines = newText.length === 0 ? 0 : newText.split("\n").length;
    if (newLines > oldLines) added += newLines - oldLines;
    if (oldLines > newLines) removed += oldLines - newLines;
  }

  if (added === 0 && removed === 0) return undefined;
  return `+${added} -${removed}`;
}

export function formatToolCall(toolName: string, args: unknown): string {
  const path = extractPathArg(args);
  const command = extractCommandArg(args);

  if (toolName === "subagent" && args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    const scope = typeof record.agentScope === "string" ? ` [${record.agentScope}]` : "";
    if (typeof record.agent === "string") {
      const taskPreview = typeof record.task === "string" ? summarizeValue(record.task, 60) : undefined;
      return taskPreview
        ? `\`subagent\` \`${record.agent}${scope}\` \`${taskPreview}\``
        : `\`subagent\` \`${record.agent}${scope}\``;
    }
    if (Array.isArray(record.tasks)) {
      return `\`subagent\` \`parallel (${record.tasks.length} tasks)${scope}\``;
    }
    if (Array.isArray(record.chain)) {
      return `\`subagent\` \`chain (${record.chain.length} steps)${scope}\``;
    }
    return `\`subagent\`${scope ? ` \`${scope.trim()}\`` : ""}`;
  }

  if (toolName === "bash") {
    const cwd = path && command ? `${path} · ${command}` : command ?? path;
    if (cwd) return `\`bash\` \`${cwd}\``;
  }

  if (toolName === "edit") {
    const delta = formatEditDelta(args);
    if (path && delta) return `\`edit\` \`${path}\` \`${delta}\``;
    if (path) return `\`edit\` \`${path}\``;
  }

  if ((toolName === "read" || toolName === "write" || toolName === "find" || toolName === "ls") && path) {
    return `\`${toolName}\` \`${path}\``;
  }

  if (toolName === "grep") {
    const target = path ? `${path}${command ? ` ${command}` : ""}`.trim() : command;
    if (target) return `\`grep\` \`${target}\``;
  }

  if (path) return `\`${toolName}\` \`${path}\``;
  if (command) return `\`${toolName}\` \`${command}\``;
  return `\`${toolName}\``;
}

function formatFailureDetail(args: unknown): string | undefined {
  const command = extractCommandArg(args);
  if (!command) return undefined;
  const singleLine = command.replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  return singleLine.length <= 140 ? singleLine : `${singleLine.slice(0, 139)}…`;
}

function formatToolLine(entry: ToolEntry): string {
  const statusIcon = entry.status === "failed" ? "❌" : entry.status === "done" ? "✅" : "🟡";
  return entry.status === "failed" && entry.detail
    ? `${statusIcon} ${entry.line}\n  ↳ ${entry.detail}`
    : `${statusIcon} ${entry.line}`;
}

async function createChannelHandle(
  send: (payload: LiveMessagePayload) => Promise<Message>,
  payload: LiveMessagePayload,
): Promise<EditableMessageHandle> {
  const message = await send(payload);
  return {
    edit: async (next) => {
      await message.edit({
        content: next.content ?? null,
        embeds: next.embeds ?? [],
        components: next.components ?? [],
        allowedMentions: { parse: [] },
      });
    },
  };
}

export function createChannelLiveMessageTarget(channel: {
  send: (options: { content?: string; embeds?: EmbedBuilder[]; components?: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>>; allowedMentions: { parse: [] } }) => Promise<Message>;
}): LiveMessageTarget {
  return {
    ensurePrimary: (payload) => createChannelHandle(
      (value) => channel.send({ content: value.content, embeds: value.embeds, components: value.components, allowedMentions: { parse: [] } }),
      payload,
    ),
    createFollowUp: (payload) => createChannelHandle(
      (value) => channel.send({ content: value.content, embeds: value.embeds, components: value.components, allowedMentions: { parse: [] } }),
      payload,
    ),
  };
}

export function createInteractionLiveMessageTarget(interaction: ChatInputCommandInteraction): LiveMessageTarget {
  let primaryInitialized = false;

  return {
    ensurePrimary: async (payload) => {
      const request = { content: payload.content, embeds: payload.embeds, components: payload.components };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(request);
      } else {
        await interaction.reply({ ...request, ephemeral: true });
      }
      primaryInitialized = true;
      return {
        edit: async (next) => {
          await interaction.editReply({ content: next.content, embeds: next.embeds, components: next.components });
        },
      };
    },
    createFollowUp: async (payload) => {
      if (!primaryInitialized && !(interaction.deferred || interaction.replied)) {
        await interaction.reply({ content: payload.content, embeds: payload.embeds, components: payload.components, ephemeral: true });
        primaryInitialized = true;
        return {
          edit: async (next) => {
            await interaction.editReply({ content: next.content, embeds: next.embeds, components: next.components });
          },
        };
      }

      const message = await interaction.followUp({
        content: payload.content,
        embeds: payload.embeds,
        components: payload.components,
        allowedMentions: { parse: [] },
        ephemeral: true,
        fetchReply: true,
      });
      if (!("edit" in message)) {
        return { edit: async () => undefined };
      }
      return {
        edit: async (next) => {
          await message.edit({
            content: next.content ?? null,
            embeds: next.embeds ?? [],
            components: next.components ?? [],
            allowedMentions: { parse: [] },
          });
        },
      };
    },
  };
}

export class LiveDiscordRunRenderer {
  private readonly tools = new Map<string, ToolEntry>();
  private readonly timeline: TimelineEntry[] = [];
  private readonly handles: EditableMessageHandle[] = [];
  private activeAssistantEntry?: AssistantEntry;
  private activeThinkingEntry?: ThinkingEntry;
  private thinkingActive = false;
  private thinkingVisible: boolean;
  private flushTimer?: NodeJS.Timeout;
  private flushPromise: Promise<void> = Promise.resolve();
  private finalized = false;
  private sawAssistantDelta = false;
  private skillLabel?: string;
  private skillDetails?: string;
  private runModelReference?: string;
  private runThinkingLevel?: string;
  private runContextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  private accessRequest?: { content: string; requestId?: string; handle?: EditableMessageHandle };

  constructor(private readonly target: LiveMessageTarget, options?: { thinkingVisible?: boolean }) {
    this.thinkingVisible = options?.thinkingVisible ?? false;
  }

  setSkillContext(skillName: string, args?: string): void {
    this.skillLabel = skillName;
    this.skillDetails = args?.trim() ? args.trim() : undefined;
  }

  async showAccessRequest(content: string, requestId?: string): Promise<void> {
    const summaryMatch = content.match(/Requested action:\s*(.+)/);
    const summary = summaryMatch ? summaryMatch[1]?.trim() : content;

    const embed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle("🔒 Permission Request")
      .setDescription(summary || content)
      .setFooter({ text: requestId ? `Request ID: ${requestId}` : "Action requires owner approval" });

    const payload: LiveMessagePayload = {
      content: "",
      embeds: [embed],
      components: requestId
        ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`access:once:${requestId}`).setLabel("Allow once").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`access:always:${requestId}`).setLabel("Always allow").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`access:deny:${requestId}`).setLabel("Deny").setStyle(ButtonStyle.Danger),
          )]
        : [],
    };

    if (!this.accessRequest?.handle) {
      const handle = await this.target.createFollowUp(payload);
      this.accessRequest = { content, requestId, handle };
      return;
    }

    await this.accessRequest.handle.edit(payload);
    this.accessRequest = { ...this.accessRequest, content, requestId };
  }

  async onUpdate(update: PiLiveUpdate): Promise<void> {
    if (this.finalized) return;

    if (update.type === "run_state") {
      this.runModelReference = update.modelReference ?? this.runModelReference;
      this.runThinkingLevel = update.thinkingLevel ?? this.runThinkingLevel;
      this.runContextUsage = update.contextUsage ?? this.runContextUsage;
      this.scheduleFlush();
      return;
    }

    if (update.type === "assistant_delta") {
      if (!update.delta) return;
      this.sawAssistantDelta = true;
      this.activeAssistantEntry ??= this.createAssistantEntry();
      this.activeAssistantEntry.text += update.delta;
      this.scheduleFlush();
      return;
    }

    if (update.type === "thinking_start") {
      this.thinkingActive = true;
      if (this.thinkingVisible) {
        this.activeThinkingEntry = { kind: "thinking", text: "" };
        this.timeline.push(this.activeThinkingEntry);
      }
      this.scheduleFlush();
      return;
    }

    if (update.type === "thinking_delta") {
      if (!update.delta) return;
      if (this.thinkingVisible && this.activeThinkingEntry) {
        this.activeThinkingEntry.text += update.delta;
      }
      this.scheduleFlush();
      return;
    }

    if (update.type === "thinking_end") {
      this.thinkingActive = false;
      this.activeThinkingEntry = undefined;
      this.scheduleFlush();
      return;
    }

    if (update.type === "tool_start") {
      if (this.tools.has(update.toolCallId)) return;
      this.activeAssistantEntry = undefined;
      const tool: ToolEntry = {
        callId: update.toolCallId,
        toolName: update.toolName,
        line: formatToolCall(update.toolName, update.args),
        status: "running",
        args: update.args,
      };
      this.tools.set(update.toolCallId, tool);
      this.timeline.push({ kind: "tool", tool });
      this.scheduleFlush();
      return;
    }

    if (update.type === "tool_update") {
      const entry = this.tools.get(update.toolCallId);
      if (!entry) return;
      if (typeof update.args !== "undefined") {
        entry.args = update.args;
        entry.line = formatToolCall(update.toolName, update.args);
      }
      if (typeof update.detail !== "undefined") {
        entry.outputDetail = update.detail;
      }
      this.scheduleFlush();
      return;
    }

    if (update.type === "tool_end") {
      const entry = this.tools.get(update.toolCallId);
      if (!entry) return;
      if (typeof update.args !== "undefined") {
        entry.args = update.args;
        entry.line = formatToolCall(update.toolName, update.args);
      }
      if (typeof update.detail !== "undefined") {
        entry.outputDetail = update.detail;
      }
      entry.status = update.isError ? "failed" : "done";
      entry.detail = update.isError ? formatFailureDetail(update.detail ?? update.args) : undefined;
      this.scheduleFlush();
    }
  }

  async finalize(finalResponse: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    if (!this.sawAssistantDelta) {
      this.activeAssistantEntry ??= this.createAssistantEntry();
      this.activeAssistantEntry.text += finalResponse || "Done.";
    }

    for (const entry of this.tools.values()) {
      if (entry.status === "running") entry.status = "done";
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    await this.flush();
  }

  private createAssistantEntry(): AssistantEntry {
    const entry: AssistantEntry = { kind: "assistant", text: "" };
    this.timeline.push(entry);
    return entry;
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  private buildTranscript(): string {
    const lines: string[] = [];

    if (this.skillLabel) {
      lines.push(`🧠 skill \`${this.skillLabel}\``);
      if (this.skillDetails) {
        lines.push(this.skillDetails);
      }
      lines.push("");
    }

    for (const entry of this.timeline) {
      if (entry.kind === "assistant") {
        const text = entry.text.trim();
        if (!text) continue;
        lines.push(text, "");
        continue;
      }

      if (entry.kind === "thinking") {
        const text = entry.text.trim();
        if (!text) continue;
        lines.push(`🧠 Thinking:\n${text}`, "");
        continue;
      }

      lines.push(formatToolLine(entry.tool), "");
    }

    // Show thinking placeholder when thinking is active but hidden
    if (this.thinkingActive && !this.thinkingVisible) {
      lines.push("🧠 Thinking...", "");
    }

    const contextLine = this.runContextUsage
      ? this.runContextUsage.tokens === null
        ? `- Context: estimating / ${this.runContextUsage.contextWindow.toLocaleString()}`
        : `- Context: ${this.runContextUsage.tokens.toLocaleString()} / ${this.runContextUsage.contextWindow.toLocaleString()} (${(this.runContextUsage.percent ?? 0).toFixed(1)}%)`
      : undefined;

    const metadata = [
      this.runModelReference ? `- Model: ${this.runModelReference}` : undefined,
      this.runThinkingLevel ? `- Thinking: ${this.runThinkingLevel}` : undefined,
      contextLine,
    ].filter((line): line is string => Boolean(line));

    if (metadata.length > 0) {
      lines.push(metadata.join("\n"));
    }

    const rendered = lines.join("\n").trim();
    return rendered || RESPONSE_PLACEHOLDER;
  }

  private async flush(): Promise<void> {
    this.flushPromise = this.flushPromise.then(async () => {
      const rendered = normalizeDiscordText(this.buildTranscript());
      const chunks = chunkDiscordMarkdown(rendered);

      for (let index = 0; index < chunks.length; index++) {
        const payload: LiveMessagePayload = { content: chunks[index] || "Done." };
        const existing = this.handles[index];
        if (existing) {
          await existing.edit(payload);
          continue;
        }
        const handle = index === 0
          ? await this.target.ensurePrimary(payload)
          : await this.target.createFollowUp(payload);
        this.handles.push(handle);
      }
    });

    await this.flushPromise;
  }
}
