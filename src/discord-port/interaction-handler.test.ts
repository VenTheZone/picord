import { describe, expect, it } from "vitest";
import { buildGroupedSessionLines, buildLoginProviderLines } from "./interaction-handler.js";

describe("interaction-handler helpers", () => {
  it("groups /session lines by project and preserves useful metadata", () => {
    const lines = buildGroupedSessionLines([
      {
        projectName: "beta",
        name: "Second task",
        messageCount: 4,
        modified: new Date("2026-04-04T06:00:00.000Z"),
        cwd: "/work/beta",
      },
      {
        projectName: "alpha",
        name: "First task",
        messageCount: 12,
        modified: new Date("2026-04-04T07:00:00.000Z"),
        cwd: "/work/alpha",
      },
      {
        projectName: "alpha",
        messageCount: 2,
        modified: new Date("2026-04-04T05:00:00.000Z"),
        cwd: "/work/alpha",
      },
    ]);

    expect(lines[0]).toBe("Choose a session to restore.");
    expect(lines).toContain("**alpha**");
    expect(lines).toContain("**beta**");

    const alphaIndex = lines.indexOf("**alpha**");
    const betaIndex = lines.indexOf("**beta**");
    expect(alphaIndex).toBeLessThan(betaIndex);

    expect(lines).toContain("- First task");
    expect(lines).toContain("- alpha session 2");
    expect(lines).toContain("  /work/alpha");
    expect(lines.some((line) => line.includes("12 msg"))).toBe(true);
    expect(lines.some((line) => line.includes("4 msg"))).toBe(true);
  });

  it("builds readable /login provider summary lines", () => {
    const lines = buildLoginProviderLines([
      { name: "ChatGPT Plus/Pro (Codex Subscription)", method: "oauth", hasStoredAuth: true },
      { name: "OpenRouter", method: "api-key", hasStoredAuth: false },
    ]);

    expect(lines).toEqual([
      "Choose a provider to log in or update.",
      "- ChatGPT Plus/Pro (Codex Subscription) (oauth, configured)",
      "- OpenRouter (api-key, not configured)",
    ]);
  });
});
