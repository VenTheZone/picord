import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Client, TextChannel, ThreadChannel } from "discord.js";
import type { PicordRuntimeConfig } from "../types.js";

// Missed-message backfill ported from hermes adapter.py:2484-2768 +
// delivery_ledger.py: Discord does NOT replay messages missed while the
// gateway was down. On each fresh identify we scan managed channels and
// their active threads for user messages after our cursor that never got a
// bot reply, and re-dispatch them. The channel history itself is the
// delivery ledger — a bot message after the user message means delivered.

export interface BackfillCandidate {
  channelId: string;
  messageId: string;
}

interface CursorFile {
  version: 1;
  cursors: Record<string, string>; // channelId -> last processed message id
}

export function cursorPath(statePath: string): string {
  return `${statePath}.backfill.json`;
}

export function loadCursors(statePath: string): Record<string, string> {
  try {
    const p = cursorPath(statePath);
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf8")) as CursorFile;
    return parsed.cursors ?? {};
  } catch {
    return {};
  }
}

export function saveCursors(statePath: string, cursors: Record<string, string>): void {
  try {
    writeFileSync(cursorPath(statePath), JSON.stringify({ version: 1, cursors } satisfies CursorFile));
  } catch {
    /* next boot re-scans; claim-set dedup prevents double-run */
  }
}

/**
 * Pure selector: given ascending-sorted channel messages, return user
 * messages that (a) are newer than `afterId`, (b) are not bot/author-bot,
 * (c) have no later bot message (delivered), and (d) for project channels,
 * did not already spawn a session thread. Bounded by `maxDispatches`.
 */
export function selectMissedMessages(
  messages: Array<{
    id: string;
    author: { bot: boolean };
    hasThread?: boolean;
    content?: string;
    attachments?: { size: number };
  }>,
  afterId: string | undefined,
  maxDispatches: number,
): number[] {
  // messages must be ascending by id (snowflake).
  const after = afterId ? BigInt(afterId) : 0n;
  const lastBotIndex = messages.reduce(
    (acc, m, i) => (m.author.bot && BigInt(m.id) > after ? i : acc),
    -1,
  );
  const picked: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (picked.length >= maxDispatches) break;
    const m = messages[i];
    if (BigInt(m.id) <= after) continue;
    if (m.author.bot) continue;
    if (i < lastBotIndex) continue; // a later bot message means it was answered
    if (m.hasThread) continue; // project-channel mention already spawned a thread
    if (!(m.content ?? "").trim() && !(m.attachments?.size ?? 0)) continue;
    picked.push(i);
  }
  return picked;
}

const BACKFILL_LIMIT = 50;
const MAX_DISPATCHES_PER_CHANNEL = 3;

export async function runBackfill(
  client: Client,
  config: PicordRuntimeConfig,
  managedChannelIds: string[],
  dispatch: (channelId: string, messageId: string) => Promise<void>,
  log: (msg: string) => void,
): Promise<number> {
  const cursors = loadCursors(config.statePath);
  let dispatched = 0;

  const scanTargets: Array<{ id: string; fetch: () => Promise<Array<{
    id: string;
    author: { bot: boolean };
    hasThread?: boolean;
    content?: string;
    attachments?: { size: number };
    channel: { sendTyping?: () => Promise<unknown> };
  }>> }> = [];

  for (const channelId of managedChannelIds) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !("messages" in channel)) continue;
      const text = channel as TextChannel;
      scanTargets.push({ id: channelId, fetch: () => fetchAscending(text) });
      for (const thread of text.threads.cache.values()) {
        scanTargets.push({ id: thread.id, fetch: () => fetchAscending(thread as unknown as TextChannel) });
      }
    } catch {
      /* channel deleted/unavailable — skip */
    }
  }

  for (const target of scanTargets) {
    try {
      const raw = await target.fetch();
      const afterId = cursors[target.id];
      // First sight of a channel: seed the cursor, never replay history.
      if (afterId) {
        const indices = selectMissedMessages(raw, afterId, MAX_DISPATCHES_PER_CHANNEL);
        for (const index of indices) {
          await dispatch(target.id, raw[index].id);
          dispatched += 1;
        }
      }
      const newest = raw[raw.length - 1];
      if (newest) cursors[target.id] = newest.id;
    } catch (error) {
      log(`backfill scan ${target.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  saveCursors(config.statePath, cursors);
  return dispatched;
}

async function fetchAscending(channel: TextChannel | ThreadChannel) {
  const messages = await channel.messages.fetch({ limit: BACKFILL_LIMIT });
  // discord.js cache is newest-first; sort ascending by snowflake.
  return [...messages.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}
