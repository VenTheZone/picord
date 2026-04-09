import { describe, expect, it } from "vitest";
import {
  buildAccessRequestLines,
  buildGroupedSessionLines,
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
    expect(embed.description).toContain("device code login");
    expect(embed.fields?.some((field) => field.name === "Device code" && field.value.includes("ABCD-EFGH"))).toBe(true);
    expect(embed.fields?.some((field) => field.name === "Instructions" && field.value.includes("enter code: ABCD-EFGH"))).toBe(true);
  });

  it("builds an OAuth login embed that explains the localhost callback fallback when no device code exists", () => {
    const embed = buildOAuthLoginEmbed({
      providerName: "ChatGPT Plus/Pro (Codex Subscription)",
      verificationUrl: "https://example.com/verify",
      instructions: "Open the page and continue in browser.",
    }).toJSON();

    expect(embed.description).toContain("browser callback");
    expect(embed.description).toContain("Complete login");
    expect(embed.fields?.some((field) => field.name === "Device code")).toBeFalsy();
    expect(embed.fields?.some((field) => field.name === "Instructions" && field.value.includes("Open the page and continue in browser."))).toBe(true);
  });

});
