import { describe, expect, it } from "vitest";

function resolveModelCommandBehavior({
  commandName,
  inHostChannel,
  inThread,
  inGuild,
}: {
  commandName: "use-model" | "model";
  inHostChannel: boolean;
  inThread: boolean;
  inGuild: boolean;
}) {
  if (inGuild && inHostChannel) {
    return { action: "blocked", scope: "host" } as const;
  }
  if (inThread || !inGuild) {
    return { action: "set-conversation-model", scope: inThread ? "thread" : "dm" } as const;
  }
  return { action: "set-workspace-model", scope: "project-channel" } as const;
}

function resolveSessionSelectionOutcome({
  hasExistingProjectChannel,
}: {
  hasExistingProjectChannel: boolean;
}) {
  return {
    projectChannelAction: hasExistingProjectChannel ? "reuse-project-channel" : "create-project-channel",
    threadAction: "create-thread",
    sessionAction: "resume-session",
  } as const;
}

function resolveLoginSelectionBehavior({
  providerId,
  method,
}: {
  providerId: string;
  method: "api-key" | "oauth";
}) {
  if (providerId === "openai-codex") {
    return { action: "start-openai-codex-login", nextStep: "openai-code-modal" } as const;
  }
  return {
    action: method === "api-key" ? "show-api-key-modal" : "start-oauth-login",
    nextStep: method === "api-key" ? "api-key-modal" : "oauth-follow-up",
  } as const;
}

describe("interaction command logic", () => {
  it("treats /model exactly like /use-model across locations", () => {
    const cases = [
      { inHostChannel: true, inThread: false, inGuild: true, expected: { action: "blocked", scope: "host" } },
      { inHostChannel: false, inThread: false, inGuild: true, expected: { action: "set-workspace-model", scope: "project-channel" } },
      { inHostChannel: false, inThread: true, inGuild: true, expected: { action: "set-conversation-model", scope: "thread" } },
      { inHostChannel: false, inThread: false, inGuild: false, expected: { action: "set-conversation-model", scope: "dm" } },
    ] as const;

    for (const testCase of cases) {
      expect(resolveModelCommandBehavior({ commandName: "use-model", ...testCase })).toEqual(testCase.expected);
      expect(resolveModelCommandBehavior({ commandName: "model", ...testCase })).toEqual(testCase.expected);
    }
  });

  it("restoring a session either reuses or creates the project channel before resuming", () => {
    expect(resolveSessionSelectionOutcome({ hasExistingProjectChannel: true })).toEqual({
      projectChannelAction: "reuse-project-channel",
      threadAction: "create-thread",
      sessionAction: "resume-session",
    });

    expect(resolveSessionSelectionOutcome({ hasExistingProjectChannel: false })).toEqual({
      projectChannelAction: "create-project-channel",
      threadAction: "create-thread",
      sessionAction: "resume-session",
    });
  });

  it("routes /login provider choices to the correct next step", () => {
    expect(resolveLoginSelectionBehavior({ providerId: "openai-codex", method: "oauth" })).toEqual({
      action: "start-openai-codex-login",
      nextStep: "openai-code-modal",
    });

    expect(resolveLoginSelectionBehavior({ providerId: "openrouter", method: "api-key" })).toEqual({
      action: "show-api-key-modal",
      nextStep: "api-key-modal",
    });

    expect(resolveLoginSelectionBehavior({ providerId: "github-copilot", method: "oauth" })).toEqual({
      action: "start-oauth-login",
      nextStep: "oauth-follow-up",
    });
  });
});
