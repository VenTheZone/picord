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
    // multi-auth is a single command with subcommands
    const multiAuthCommand = commands.find((c) => c.name === "multi-auth");
    expect(multiAuthCommand).toBeDefined();
    // Verify subcommands exist
    const subcommands = (multiAuthCommand as any).options?.map((o: any) => o.name) ?? [];
    expect(subcommands).toContain("delete");
    expect(subcommands).toContain("switch");
    expect(subcommands).toContain("auto");
    expect(subcommands).toContain("rename");
    expect(subcommands).toContain("rotation");
    expect(subcommands).toContain("hide");
  });
});
