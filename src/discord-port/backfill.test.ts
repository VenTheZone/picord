import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCursors, saveCursors, selectMissedMessages } from "./backfill.js";

const msg = (id: string, bot = false, extra: Record<string, unknown> = {}) => ({
  id,
  author: { bot },
  content: bot ? "reply" : "do the thing",
  ...extra,
});

describe("selectMissedMessages", () => {
  it("picks user messages after the cursor with no later bot reply", () => {
    const messages = [
      msg("10"), msg("11", true), // answered, before cursor anyway
      msg("20"), // missed
      msg("21"), // missed
      msg("22", true), // reply to 21 -> 21 answered, 20 still missed? no: bot after both
    ];
    // bot at 22 is after 20 and 21, so both count as answered.
    expect(selectMissedMessages(messages, "11", 3)).toEqual([]);
  });

  it("returns indices of unanswered user messages after cursor", () => {
    const messages = [
      msg("10"),
      msg("11", true),
      msg("20"), // missed -> index 2
      msg("21"), // missed -> index 3
    ];
    expect(selectMissedMessages(messages, "11", 3)).toEqual([2, 3]);
  });

  it("caps dispatches", () => {
    const messages = [msg("20"), msg("21"), msg("22")];
    expect(selectMissedMessages(messages, "10", 2)).toEqual([0, 1]);
  });

  it("skips messages that already spawned a thread and empty messages", () => {
    const messages = [
      msg("20", false, { hasThread: true }),
      msg("21", false, { content: "  ", attachments: { size: 0 } }),
      msg("22", false, { content: "", attachments: { size: 1 } }),
    ];
    expect(selectMissedMessages(messages, "10", 3)).toEqual([2]);
  });

  it("treats bot messages before the user message as no answer", () => {
    const messages = [msg("15", true), msg("20")];
    expect(selectMissedMessages(messages, "10", 3)).toEqual([1]);
  });
});

describe("cursor persistence", () => {
  it("round-trips through the state file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "picord-bf-"));
    const statePath = path.join(dir, "picord.state.json");
    expect(loadCursors(statePath)).toEqual({});
    saveCursors(statePath, { "c-1": "123" });
    expect(loadCursors(statePath)).toEqual({ "c-1": "123" });
    expect(JSON.parse(readFileSync(`${statePath}.backfill.json`, "utf8")).version).toBe(1);
  });
});
