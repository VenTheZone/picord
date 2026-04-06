import { describe, expect, it } from "vitest";
import { buildDiscordPortCommands } from "./command-registration.js";

describe("buildDiscordPortCommands", () => {
  it("includes the Discord-specific workflow commands we added", () => {
    const commands = buildDiscordPortCommands();
    const names = commands.map((command) => command.name);

    expect(names).toContain("add-project");
    expect(names).toContain("add-project-path");
    expect(names).toContain("project-list-available");
    expect(names).toContain("refresh-session");
    expect(names).toContain("model");
    expect(names).toContain("think");
    expect(names).toContain("login");
    expect(names).toContain("session");
    expect(names).toContain("outside-workspace-access");
    expect(names).not.toContain("login-complete");
  });

  it("registers /model as an alias of /use-model", () => {
    const commands = buildDiscordPortCommands();
    const useModel = commands.find((command) => command.name === "use-model");
    const model = commands.find((command) => command.name === "model");

    expect(useModel).toBeDefined();
    expect(model).toBeDefined();
    expect(model?.description).toBe(useModel?.description);
    expect(model?.options).toEqual(useModel?.options);
  });

  it("registers /think with the expected levels", () => {
    const commands = buildDiscordPortCommands();
    const think = commands.find((command) => command.name === "think");
    const levelOption = think?.options?.find((option) => option.name === "level");
    const choices = levelOption && "choices" in levelOption ? levelOption.choices?.map((choice) => choice.name) : [];

    expect(think).toBeDefined();
    expect(choices).toEqual(["none", "low", "medium", "high", "xhigh"]);
  });
});
