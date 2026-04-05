import { describe, expect, it } from "vitest";
import { buildToolPanelEmbed, chunkDiscordMarkdown, formatToolCall, normalizeDiscordText } from "./live-discord-renderer.js";

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

  it("formats tool calls like kimaki-style status lines", () => {
    expect(formatToolCall("read", { path: "src/index.ts" })).toBe("`read` \"src/index.ts\"");
    expect(formatToolCall("bash", { command: "npm test" })).toBe("`bash` \"npm test\"");
  });

  it("chunks long assistant content without adding a response header", () => {
    const chunks = chunkDiscordMarkdown("hello ".repeat(1000), 200);
    expect(chunks[0]?.startsWith("🤖 **Response**")).toBe(false);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("builds a tool container without a tools-used label", () => {
    const embed = buildToolPanelEmbed([
      { callId: "1", line: "`read` \"src/index.ts\"", status: "done" },
      { callId: "2", line: "`edit` \"src/live-discord-renderer.ts\"", status: "running" },
    ], false).toJSON();

    expect(embed.title).toBeUndefined();
    expect(embed.description).toContain("✅ `read`");
    expect(embed.description).toContain("🟡 `edit`");
    expect(embed.description).not.toContain("Tools used");
    expect(embed.footer?.text).toContain("running");
  });
});
