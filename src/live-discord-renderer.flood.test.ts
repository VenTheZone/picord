import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LiveDiscordRunRenderer,
  chunkDiscordMarkdown,
  tablesToBullets,
  type LiveMessagePayload,
} from "./live-discord-renderer.js";
import { capChunks } from "./discord-port/message-helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("chunkDiscordMarkdown size cap", () => {
  it("never emits chunks longer than maxLength even with fence reopen carry", () => {
    const text = "```ts\n" + "x".repeat(40) + "\n" + "y".repeat(40) + "\n```";
    for (const chunk of chunkDiscordMarkdown(text, 24)) {
      expect(chunk.length).toBeLessThanOrEqual(24);
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });
});

describe("tablesToBullets", () => {
  it("converts pipe tables to bullet lines and drops the separator row", () => {
    const out = tablesToBullets("| Name | Age |\n|---|---|\n| V | 30 |\nplain");
    expect(out).toBe("**Name:** V · **Age:** 30\nplain");
  });
  it("leaves non-table text untouched", () => {
    expect(tablesToBullets("a | b\nc")).toBe("a | b\nc");
  });
});

describe("capChunks", () => {
  it("caps a flood of chunks with a truncation notice", () => {
    const out = capChunks(Array.from({ length: 20 }, (_, i) => `c${i}`));
    expect(out.length).toBe(8);
    expect(out[7]).toContain("truncated");
    expect(out.slice(0, 7)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6"]);
  });
  it("passes through small replies", () => {
    expect(capChunks(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("renderer flood behavior", () => {
  const flush = (renderer: LiveDiscordRunRenderer) =>
    (renderer as unknown as { flush(): Promise<void> }).flush();

  it("skips no-op edits when rendered text is unchanged (saturated preview dedup)", async () => {
    vi.useFakeTimers(); // keep the 75ms scheduled flush from firing
    const edits: string[] = [];
    const renderer = new LiveDiscordRunRenderer({
      ensurePrimary: async () => ({
        edit: async (next) => {
          edits.push(next.content ?? "");
        },
      }),
      createFollowUp: async () => ({ edit: async () => undefined }),
    });

    await renderer.onUpdate({ type: "assistant_delta", delta: "hello" });
    await flush(renderer); // creates primary handle, no edit
    await flush(renderer); // identical text -> dedup skip
    expect(edits.length).toBe(0);

    await renderer.onUpdate({ type: "assistant_delta", delta: " world" });
    await flush(renderer);
    expect(edits).toEqual(["hello world"]);
  });

  it("disables edits after repeated failures and resends final as fresh message", async () => {
    vi.useFakeTimers();
    let editCalls = 0;
    const followUps: LiveMessagePayload[] = [];
    const renderer = new LiveDiscordRunRenderer({
      ensurePrimary: async () => ({
        edit: async () => {
          editCalls += 1;
          throw new Error("429 edit flood");
        },
      }),
      createFollowUp: async (payload) => {
        followUps.push(payload);
        return { edit: async () => undefined };
      },
    });

    await renderer.onUpdate({ type: "assistant_delta", delta: "part0 " });
    await flush(renderer); // sends primary, no edit yet
    for (let i = 1; i <= 5; i++) {
      await renderer.onUpdate({ type: "assistant_delta", delta: `part${i} ` });
      await flush(renderer); // text changes -> edit attempted, fails -> strikes
    }
    expect(editCalls).toBe(3); // MAX_EDIT_STRIKES, then edits disabled

    await renderer.finalize("ignored, deltas seen");
    expect(editCalls).toBe(3); // no edits after disable
    expect(followUps.some((f) => f.content?.startsWith("part0"))).toBe(true);
  });
});
