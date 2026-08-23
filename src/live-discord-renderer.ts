import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, type ChatInputCommandInteraction, type Message } from "discord.js";

const FLUSH_INTERVAL_MS = 75;
const RESPONSE_PLACEHOLDER = "_thinking…_";

/**
 * Discord hard message length limit (characters). Payloads over this are
 * rejected by the API.
 */
export const DISCORD_MESSAGE_HARD_LIMIT = 2000;

/**
 * Effective ceiling for every outgoing normal assistant-content chunk.
 *
 * Discord rejects payloads over `DISCORD_MESSAGE_HARD_LIMIT` chars. Chunking
 * must never emit a chunk that exceeds the limit even after adding markdown
 * code-fence carry/reopen prefixes and closing fences, so content is budgeted
 * below the hard limit with room for the worst-case fence syntax. The 1800
 * ceiling is deliberately conservative and applies to every outgoing chunk
 * (including fence reopen/close syntax). Callers that need a different ceiling
 * can pass `maxLength` explicitly to `chunkDiscordMarkdown`; the per-chunk
 * guarantee holds for any realistic limit that can fit the fence syntax.
 */
export const DISCORD_MESSAGE_EFFECTIVE_LIMIT = 1800;

/**
 * Short marker appended when a stream terminates early without an error
 * (user interrupt, superseded run, aborted stream, …) so the sealed message
 * never ends silently as if it were complete.
 */
export const INCOMPLETE_MARKER = "\n\n_…(incomplete — stream ended early)_";

/** Concise visible fallback sent when finalization cannot update the live message. */
const FINALIZE_FALLBACK_MESSAGE = "⚠️ _Run finished, but the live message could not be updated._";

/** Chars appended by `ensureClosedCodeFence` to balance an open code block. */
const FENCE_CLOSER_OVERHEAD = "\n```".length;

export type PiLiveUpdate =
  | { type: "assistant_delta"; delta: string }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_end" }
  | { type: "run_state"; modelReference?: string; thinkingLevel?: string; supportsThinking?: boolean; contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } }
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

export function chunkDiscordMarkdown(text: string, maxLength: number = DISCORD_MESSAGE_EFFECTIVE_LIMIT): string[] {
  if (!text) return ["Done."];

  const chunks: string[] = [];
  let carryPrefix = "";
  let remaining = text;

  while (remaining.length > 0) {
    // Budget content so that even after prepending the fence carry/reopen
    // prefix AND appending the balancing closing fence the assembled chunk
    // is mathematically guaranteed to stay within `maxLength`:
    //   assembled = prefix + take <= prefix + (maxLength - prefix - closer)
    //             = maxLength - closer
    //   closed    = assembled (+ closer at most) <= maxLength
    // `.trim()` only shortens, so the bound is exact. Fence state is carried
    // between chunks via `carryPrefix`, keeping code blocks readable across
    // chunk boundaries without ever producing an illegal over-long payload.
    const contentBudget = Math.max(1, maxLength - carryPrefix.length - FENCE_CLOSER_OVERHEAD);

    let take: string;
    if (remaining.length <= contentBudget) {
      take = remaining;
      remaining = "";
    } else {
      const slice = remaining.slice(0, contentBudget);
      // Prefer breaking at a line or word boundary; fall back to a hard slice
      // (same strategy as the previous implementation) for single over-long
      // lines so the loop always makes progress.
      const splitAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
      const index = splitAt > 0 ? splitAt : contentBudget;
      take = remaining.slice(0, index);
      remaining = remaining.slice(index);
    }

    const assembled = `${carryPrefix}${take}`;
    const closed = ensureClosedCodeFence(assembled).trim();
    chunks.push(closed || "Done.");
    carryPrefix = reopenFencePrefix(assembled);
  }

  return chunks;
}

function safeErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 197)}…` : message;
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

export function createInteractionLiveMessageTarget(interaction: ChatInputCommandInteraction, ephemeral: boolean = true): LiveMessageTarget {
  let primaryInitialized = false;

  return {
    ensurePrimary: async (payload) => {
      const request = { content: payload.content, embeds: payload.embeds, components: payload.components };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(request);
      } else {
        await interaction.reply({ ...request, ephemeral });
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
        await interaction.reply({ content: payload.content, embeds: payload.embeds, components: payload.components, ephemeral });
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
  private incompleteMarked = false;
  private sawAssistantDelta = false;
  private skillLabel?: string;
  private skillDetails?: string;
  private runModelReference?: string;
  private runThinkingLevel?: string;
  private runSupportsThinking?: boolean;
  private runContextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  private accessRequest?: { content: string; requestId?: string; handle?: EditableMessageHandle };

  private initialPlaceholderSent = false;

  constructor(private readonly target: LiveMessageTarget, options?: { thinkingVisible?: boolean }) {
    this.thinkingVisible = options?.thinkingVisible ?? false;
  }

  /** Show immediate placeholder message before any content arrives. */
  async showThinkingPlaceholder(): Promise<void> {
    if (this.initialPlaceholderSent || this.finalized) return;
    this.initialPlaceholderSent = true;
    const payload: LiveMessagePayload = { content: RESPONSE_PLACEHOLDER };
    const handle = await this.target.ensurePrimary(payload);
    this.handles.push(handle);
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
      this.runSupportsThinking = update.supportsThinking ?? this.runSupportsThinking;
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

  /**
   * Seal current Discord messages — final flush, then stop editing them.
   * The renderer stays alive to create new follow-up messages for the continuation.
   * Used when the user interrupts mid-stream: their message appears in chat
   * naturally, and the AI continues in a new message below.
   */
  async sealCurrentMessages(): Promise<void> {
    if (this.finalized) return;

    // Non-error early termination (user interrupt / superseded run): mark
    // the sealed message explicitly instead of ending it silently.
    this.appendIncompleteMarker();

    // Cancel any pending timer and do one final flush
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();

    // Stop editing the current handles — they're sealed.
    // Next flush will create new follow-up messages.
    this.handles.length = 0;

    // Reset timeline for the continuation phase
    this.timeline.length = 0;
    this.activeAssistantEntry = undefined;
    this.activeThinkingEntry = undefined;
    this.tools.clear();
    this.sawAssistantDelta = false;
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

    try {
      await this.flush();
    } catch (error) {
      // Finalization flush failed (e.g. a Discord edit/send error). Emit a
      // concise visible fallback so the user is never left with a frozen or
      // silently incomplete message, then rethrow so existing callers keep
      // their error reporting path.
      console.error(`[picord] finalize flush failed: ${safeErrorSummary(error)}`);
      await this.sendFallback(FINALIZE_FALLBACK_MESSAGE).catch((fallbackError) => {
        console.error(`[picord] finalize fallback failed: ${safeErrorSummary(fallbackError)}`);
      });
      throw error;
    }
  }

  /**
   * Explicitly mark the current stream as ended early without an error.
   * Appends a short, visible truncation marker so the message never ends
   * silently as if it were complete.
   */
  async markIncomplete(): Promise<void> {
    if (this.finalized) return;
    this.appendIncompleteMarker();
    await this.flush();
  }

  private appendIncompleteMarker(): void {
    if (this.incompleteMarked) return;
    this.incompleteMarked = true;
    const entry = this.activeAssistantEntry ?? this.createAssistantEntry();
    entry.text += INCOMPLETE_MARKER;
  }

  private async sendFallback(content: string): Promise<void> {
    await this.target.createFollowUp({ content });
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
      // Rejection is logged (truncated, no content/secrets) instead of
      // producing an unhandled rejection; the next flush still runs thanks
      // to the self-healing chain in `flush`.
      void this.flush().catch((error) => {
        console.error(`[picord] live render flush failed: ${safeErrorSummary(error)}`);
      });
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

      if (entry.kind === "tool") {
        lines.push(formatToolLine(entry.tool), "");
        continue;
      }
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
      this.runThinkingLevel && (this.runThinkingLevel !== "off" || this.runSupportsThinking === true)
        ? `- Thinking: ${this.runThinkingLevel === "off" ? "none" : this.runThinkingLevel}`
        : undefined,
      contextLine,
    ].filter((line): line is string => Boolean(line));

    if (metadata.length > 0) {
      lines.push(metadata.join("\n"));
    }

    const rendered = lines.join("\n").trim();
    return rendered || RESPONSE_PLACEHOLDER;
  }

  async flush(): Promise<void> {
    const execute = async (): Promise<void> => {
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
    };

    // Self-healing chain: if a previous flush rejected (e.g. a Discord
    // edit/follow-up failure), the next flush must still execute instead of
    // permanently chaining onto the rejected promise and freezing live
    // rendering. The rejection is still surfaced to this caller via `await`.
    this.flushPromise = this.flushPromise.then(execute, execute);
    await this.flushPromise;
  }
}
