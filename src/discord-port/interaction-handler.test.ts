import { describe, expect, it } from "vitest";
import {
  buildAccessRequestLines,
  buildGroupedSessionLines,
  buildLoginProviderLines,
  buildOAuthLoginEmbed,
  extractDeviceCodeFromInstructions,
} from "./interaction-handler.js";

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
      { name: "ChatGPT Plus/Pro (Codex Subscription)", method: "oauth", hasStoredAuth: true, supportsDiscordFlow: true },
      {
        name: "GitHub Copilot",
        method: "oauth",
        hasStoredAuth: false,
        supportsDiscordFlow: false,
        discordFlowReason: "OAuth login for this provider is not wired into Discord yet. Use pi locally for now.",
      },
      { name: "OpenRouter", method: "api-key", hasStoredAuth: false, supportsDiscordFlow: true },
    ]);

    expect(lines).toEqual([
      "Choose a provider to log in or update.",
      "- ChatGPT Plus/Pro (Codex Subscription) (oauth, configured)",
      "- GitHub Copilot (oauth, not configured, local-only: OAuth login for this provider is not wired into Discord yet. Use pi locally for now.)",
      "- OpenRouter (api-key, not configured)",
    ]);
  });

  it("builds a clearer access request prompt", () => {
    const lines = buildAccessRequestLines({
      id: "acc-1",
      summary: "Read files outside workspace: /tmp/shared-config",
    });

    expect(lines[0]).toBe("Permission request");
    expect(lines).toContain("Request ID: acc-1");
    expect(lines).toContain("Requested action: Read files outside workspace: /tmp/shared-config");
    expect(lines).toContain("Use the buttons below to approve or deny.");
  });

  it("extracts a visible device code from oauth instructions when present", () => {
    expect(extractDeviceCodeFromInstructions("Enter code: ABCD-EFGH")).toBe("ABCD-EFGH");
    expect(extractDeviceCodeFromInstructions("One-time code: WXYZ1234")).toBe("WXYZ1234");
    expect(extractDeviceCodeFromInstructions("Open the page and continue in browser.")).toBeUndefined();
  });

  it("builds an OAuth login embed with the detected device code when available", () => {
    const embed = buildOAuthLoginEmbed({
      providerName: "ChatGPT Plus/Pro (Codex Subscription)",
      verificationUrl: "https://example.com/verify",
      instructions: "Open the page, then enter code: ABCD-EFGH",
    }).toJSON();

    expect(embed.title).toBe("ChatGPT Plus/Pro (Codex Subscription) Login");
    expect(embed.description).toContain("device code was detected");
    expect(embed.fields?.some((field) => field.name === "Device code" && field.value.includes("ABCD-EFGH"))).toBe(true);
    expect(embed.fields?.some((field) => field.name === "Provider instructions" && field.value.includes("enter code: ABCD-EFGH"))).toBe(true);
  });

  it("builds an OAuth login embed that explains the localhost callback fallback when no device code exists", () => {
    const embed = buildOAuthLoginEmbed({
      providerName: "ChatGPT Plus/Pro (Codex Subscription)",
      verificationUrl: "https://example.com/verify",
      instructions: "Open the page and continue in browser.",
    }).toJSON();

    expect(embed.description).toContain("local browser");
    expect(embed.description).toContain("not on the VPS");
    expect(embed.fields?.some((field) => field.name === "Device code" && field.value.includes("No device code exists"))).toBe(true);
    expect(embed.fields?.some((field) => field.name === "Expected redirect" && field.value.includes("not on the VPS"))).toBe(true);
    expect(embed.fields?.some((field) => field.name === "Next step" && field.value.includes("on your own computer"))).toBe(true);
    expect(embed.fields?.some((field) => field.name === "Next step" && field.value.includes("pasting just that code also works"))).toBe(true);
  });

});
