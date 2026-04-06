import { describe, expect, it } from "vitest";
import { buildDiscordPortCommands } from "./discord-port/command-registration.js";
import { buildAllMultiAuthCommands } from "./discord-port/multi-auth-commands.js";

describe("discord command sync payload", () => {
  it("includes multi-auth commands in the sync payload", () => {
    const commands = [
      ...buildDiscordPortCommands([]),
      ...buildAllMultiAuthCommands(),
    ];

    const names = commands.map((command) => command.name);
    expect(names).toContain("multi-auth");
    expect(names).toContain("multi-auth-add-apikey");
    expect(names).toContain("multi-auth-delete");
    expect(names).toContain("multi-auth-switch");
    expect(names).toContain("multi-auth-auto");
    expect(names).toContain("multi-auth-rename");
    expect(names).toContain("multi-auth-rotation");
    expect(names).toContain("multi-auth-hide");
  });
});
