import { describe, expect, it } from "vitest";
import { DISCORD_MESSAGE_EFFECTIVE_LIMIT, INCOMPLETE_MARKER, LiveDiscordRunRenderer, chunkDiscordMarkdown, formatToolCall, normalizeDiscordText, type LiveMessagePayload } from "./live-discord-renderer.js";

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

  it("never emits a chunk over the effective limit for overlong fenced markdown", () => {
    const codeLines = Array.from({ length: 400 }, (_, index) => `const line${index} = ${index};`);
    const longFenced = `\`\`\`typescript\n${codeLines.join("\n")}\n\`\`\``;
    const chunks = chunkDiscordMarkdown(longFenced);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_EFFECTIVE_LIMIT);
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    // Every chunk (including carry/reopen prefixes and closing fences) fits
    // inside the effective ceiling, fences stay balanced, and no content is
    // lost or duplicated across chunk boundaries (only fence syntax is
    // inserted between chunks).
    const stripFenceAndWhitespace = (value: string) =>
      value.replace(/```/g, "").replace(/typescript/g, "").replace(/\s/g, "");
    expect(stripFenceAndWhitespace(chunks.join(""))).toBe(stripFenceAndWhitespace(longFenced));
  });

  it("keeps normal long text within the effective limit without data loss", () => {
    const longText = "word ".repeat(2500);
    const chunks = chunkDiscordMarkdown(longText);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_EFFECTIVE_LIMIT);
    }
    expect(chunks.join("").replace(/\s/g, "")).toBe(longText.replace(/\s/g, ""));
  });

  it("honors an explicit maxLength override while still guaranteeing the cap", () => {
    const longFenced = `\`\`\`js\n${Array.from({ length: 200 }, (_, index) => `const x${index} = ${index};`).join("\n")}\n\`\`\``;
    const chunks = chunkDiscordMarkdown(longFenced, 1000);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
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

  it("seals current messages and continues in new follow-ups", async () => {
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

    // Phase 1: AI streams some content
    await renderer.onUpdate({ type: "assistant_delta", delta: "Working on it..." });
    await renderer.onUpdate({ type: "tool_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } });

    // Seal — simulates user interrupting mid-stream
    await renderer.sealCurrentMessages();

    const beforeSealCount = payloads.length;
    const beforeSeal = payloads.map((p) => p.content ?? "").join("|||");
    expect(beforeSeal).toContain("Working on it...");
    expect(beforeSeal).toContain("bash");

    // Phase 2: AI continues after steer
    await renderer.onUpdate({ type: "assistant_delta", delta: "Checking tests now." });
    await renderer.finalize("Done.");

    const afterSeal = payloads.slice(beforeSealCount).map((p) => p.content ?? "").join("|||");
    expect(afterSeal).toContain("Checking tests now.");
    // The sealed content should NOT reappear in the follow-up
    expect(afterSeal).not.toContain("Working on it...");
  });

  it("recovers from a rejected flush on the next flush", async () => {
    const payloads: LiveMessagePayload[] = [];
    let failEdit = true;
    const makeHandle = (initial: LiveMessagePayload) => {
      payloads.push(initial);
      return {
        edit: async (next: LiveMessagePayload) => {
          if (failEdit) {
            failEdit = false;
            throw new Error("discord edit failed (simulated)");
          }
          payloads.push(next);
        },
      };
    };

    const renderer = new LiveDiscordRunRenderer({
      ensurePrimary: async (payload) => makeHandle(payload),
      createFollowUp: async (payload) => makeHandle(payload),
    });

    await renderer.onUpdate({ type: "assistant_delta", delta: "First" });
    // First flush creates the primary message and succeeds.
    await renderer.flush();

    await renderer.onUpdate({ type: "assistant_delta", delta: " More" });
    // Second flush edits the existing message and fails: the rejection must
    // reach the caller…
    await expect(renderer.flush()).rejects.toThrow("discord edit failed (simulated)");

    // …but the next flush must still execute instead of chaining onto the
    // rejected promise and freezing the renderer.
    await renderer.onUpdate({ type: "assistant_delta", delta: " Second" });
    await renderer.flush();

    const combined = payloads.map((payload) => payload.content ?? "").join("\n");
    expect(combined).toContain("Second");
    await expect(renderer.flush()).resolves.toBeUndefined();
  });

  it("emits an explicit truncation marker on early non-error stream termination", async () => {
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

    await renderer.onUpdate({ type: "assistant_delta", delta: "Partial answer" });
    await renderer.sealCurrentMessages();

    const combined = payloads.map((payload) => payload.content ?? "").join("\n");
    expect(combined).toContain("Partial answer");
    expect(combined).toContain(INCOMPLETE_MARKER);
  });

  it("sends a concise visible fallback when finalization flush fails", async () => {
    const payloads: LiveMessagePayload[] = [];
    let failEdit = true;
    const makeHandle = (initial: LiveMessagePayload) => {
      payloads.push(initial);
      return {
        edit: async () => {
          if (failEdit) {
            failEdit = false;
            throw new Error("discord edit failed (simulated)");
          }
        },
      };
    };

    const renderer = new LiveDiscordRunRenderer({
      ensurePrimary: async () => {
        throw new Error("discord send failed (simulated)");
      },
      createFollowUp: async (payload) => makeHandle(payload),
    });

    await renderer.onUpdate({ type: "assistant_delta", delta: "Hello" });
    await expect(renderer.finalize("Done.")).rejects.toThrow("discord send failed (simulated)");

    // A concise fallback message must be visible despite the failed flush.
    expect(payloads.some((payload) => (payload.content ?? "").includes("could not be updated"))).toBe(true);
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
