import { describe, expect, it } from "vitest";
import { buildAllMultiAuthCommands, buildMultiAuthStatusCommand } from "./multi-auth-commands.js";

describe("multi-auth command registration", () => {
  it("builds the /multi-auth command as JSON with subcommands", () => {
    const command = buildMultiAuthStatusCommand();
    expect(command.name).toBe("multi-auth");
    expect(command.description).toBe("Manage multi-auth credentials and rotation");
    expect(command.options?.map((option) => option.name)).toEqual(["status", "usage", "health"]);
  });

  it("includes /multi-auth in the exported Discord command list", () => {
    const commands = buildAllMultiAuthCommands();
    expect(commands.some((command) => command.name === "multi-auth")).toBe(true);
  });
});
