import { describe, expect, it } from "vitest";
import { LiveDiscordRunRenderer, chunkDiscordMarkdown, formatToolCall, normalizeDiscordText, type LiveMessagePayload } from "./live-discord-renderer.js";

describe("live discord renderer helpers", () => {
  it("normalizes markdown headings and bullets outside code blocks", () => {
    const input = "## Summary\n- one\n* two\n\n```ts\n# keep\n- keep\n```";
    expect(normalizeDiscordText(input)).toBe("**Summary**\n• one\n• two\n\n```ts\n# keep\n- keep\n```");
  });

  it("preserves code fences across chunk boundaries", () => {
    const chunks = chunkDiscordMarkdown("```ts\nconst value = 1;\nconst other = 2;\n```", 18);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(chunks[0]).toContain("```ts");
    expect(chunks[1]).toContain("```");
  });

  it("formats compact tool status lines", () => {
    expect(formatToolCall("read", { path: "src/index.ts" })).toBe("`read` `src/index.ts`");
    expect(formatToolCall("bash", { command: "cd repo && npm test" })).toBe("`bash` `cd repo && npm test`");
    expect(formatToolCall("bash", { cwd: "/repo", command: "npm test" })).toBe("`bash` `/repo · npm test`");
    expect(formatToolCall("grep", { path: "src", pattern: "openai" })).toBe("`grep` `src openai`");
  });

  it("renders inline assistant and tool timeline in chronological order", async () => {
    const payloads: LiveMessagePayload[] = [];
    const makeHandle = (initial: LiveMessagePayload) => {
      payloads.push(initial);
      return {
        edit: async (next: LiveMessagePayload) => {
          payloads.push(next);
        },
      };
    };

    const renderer = new LiveDiscordRunRenderer({
      ensurePrimary: async (payload) => makeHandle(payload),
      createFollowUp: async (payload) => makeHandle(payload),
    });

    await renderer.onUpdate({ type: "assistant_delta", delta: "First message." });
    await renderer.onUpdate({ type: "tool_start", toolCallId: "1", toolName: "edit", args: { path: "src/index.ts" } });
    await renderer.onUpdate({ type: "assistant_delta", delta: "Second message." });
    await renderer.onUpdate({ type: "tool_end", toolCallId: "1", toolName: "edit", isError: false, args: { path: "src/index.ts" } });
    await renderer.onUpdate({ type: "tool_start", toolCallId: "2", toolName: "read", args: { path: "README.md" } });
    await renderer.onUpdate({ type: "tool_end", toolCallId: "2", toolName: "read", isError: false, args: { path: "README.md" } });
    await renderer.finalize("Done.");

    const combined = payloads.map((payload) => payload.content ?? "").join("\n");
    expect(combined).toContain("First message.");
    expect(combined).toContain("✅ `edit` `src/index.ts`");
    expect(combined).toContain("Second message.");
    expect(combined).toContain("✅ `read` `README.md`");
    expect(combined.indexOf("First message.")).toBeLessThan(combined.indexOf("✅ `edit` `src/index.ts`"));
    expect(combined.indexOf("✅ `edit` `src/index.ts`")).toBeLessThan(combined.indexOf("Second message."));
    expect(combined.indexOf("Second message.")).toBeLessThan(combined.indexOf("✅ `read` `README.md`"));
  });

  it("renders run metadata for model, thinking, context usage, and skill activity", async () => {
    const payloads: LiveMessagePayload[] = [];
    const makeHandle = (initial: LiveMessagePayload) => {
      payloads.push(initial);
      return {
        edit: async (next: LiveMessagePayload) => {
          payloads.push(next);
        },
      };
    };

    const renderer = new LiveDiscordRunRenderer({
      ensurePrimary: async (payload) => makeHandle(payload),
      createFollowUp: async (payload) => makeHandle(payload),
    });
    renderer.setSkillContext("brainstorming", "Refine the feature idea");

    await renderer.onUpdate({
      type: "run_state",
      modelReference: "openai-codex/gpt-5.3-codex",
      thinkingLevel: "high",
      contextUsage: { tokens: 12345, contextWindow: 272000, percent: 4.5 },
    });
    await renderer.finalize("Done.");

    expect(payloads.some((payload) => payload.content?.includes("Model: openai-codex/gpt-5.3-codex"))).toBe(true);
    expect(payloads.some((payload) => payload.content?.includes("Thinking: high"))).toBe(true);
    expect(payloads.some((payload) => payload.content?.includes("Context: 12,345 / 272,000 (4.5%)"))).toBe(true);
    expect(payloads.some((payload) => payload.content?.includes("🧠 skill `brainstorming`"))).toBe(true);
  });

  it("shows completed tool state in the inline timeline", async () => {
    const payloads: LiveMessagePayload[] = [];
    const makeHandle = (initial: LiveMessagePayload) => {
      payloads.push(initial);
      return {
        edit: async (next: LiveMessagePayload) => {
          payloads.push(next);
        },
      };
    };

    const renderer = new LiveDiscordRunRenderer({
      ensurePrimary: async (payload) => makeHandle(payload),
      createFollowUp: async (payload) => makeHandle(payload),
    });

    await renderer.onUpdate({ type: "tool_start", toolCallId: "1", toolName: "read", args: { path: "src/index.ts" } });
    await renderer.onUpdate({ type: "tool_end", toolCallId: "1", toolName: "read", isError: false, args: { path: "src/index.ts" } });
    await renderer.finalize("Done.");

    expect(payloads.some((payload) => payload.content?.includes("✅ `read` `src/index.ts`"))).toBe(true);
  });

  it("keeps output free of interactive UI clutter", async () => {
    const payloads: LiveMessagePayload[] = [];
    const makeHandle = (initial: LiveMessagePayload) => {
      payloads.push(initial);
      return {
        edit: async (next: LiveMessagePayload) => {
          payloads.push(next);
        },
      };
    };

    const renderer = new LiveDiscordRunRenderer({
      ensurePrimary: async (payload) => makeHandle(payload),
      createFollowUp: async (payload) => makeHandle(payload),
    });

    await renderer.onUpdate({ type: "assistant_delta", delta: "Hello" });
    await renderer.finalize("Done.");

    expect(payloads.every((payload) => !payload.components || payload.components.length === 0)).toBe(true);
  });
});
