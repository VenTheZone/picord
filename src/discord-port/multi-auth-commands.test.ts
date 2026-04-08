import { describe, expect, it } from "vitest";
import { buildAllMultiAuthCommands, buildMultiAuthCommand } from "./multi-auth-commands.js";
import { buildLoginCommand } from "./command-registration.js";

describe("multi-auth command registration", () => {
  it("builds the /multi-auth command as JSON with subcommands", () => {
    const command = buildMultiAuthCommand([]);
    expect(command.name).toBe("multi-auth");
    expect(command.description).toBe("Manage multi-auth credentials and rotation");
    const subcommandNames = command.options?.map((option) => option.name) ?? [];
    // login is now a separate /login command, not a subcommand
    expect(subcommandNames).toContain("status");
    expect(subcommandNames).toContain("usage");
    expect(subcommandNames).toContain("health");
    expect(subcommandNames).toContain("delete");
    expect(subcommandNames).toContain("switch");
    expect(subcommandNames).toContain("auto");
    expect(subcommandNames).toContain("rename");
    expect(subcommandNames).toContain("rotation");
    expect(subcommandNames).toContain("hide");
  });

  it("includes /multi-auth in the exported Discord command list", () => {
    const commands = buildAllMultiAuthCommands([]);
    expect(commands.some((command) => command.name === "multi-auth")).toBe(true);
  });

  it("builds the /login command as JSON", () => {
    const command = buildLoginCommand();
    expect(command.name).toBe("login");
    expect(command.description).toBe("Add or update API keys and OAuth credentials for providers");
  });
});
