import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceRegistry } from "./workspace-registry.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "picord-workspace-registry-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("WorkspaceRegistry", () => {
  it("persists outside-workspace access per project", () => {
    const dir = createTempDir();
    const statePath = path.join(dir, "picord.state.json");

    const registry = new WorkspaceRegistry(statePath);
    registry.load();
    registry.upsert("123", "/workspace/demo", "demo");
    registry.setOutsideWorkspaceAllowed("123", true);

    const reloaded = new WorkspaceRegistry(statePath);
    reloaded.load();

    expect(reloaded.isOutsideWorkspaceAllowed("123")).toBe(true);
    expect(reloaded.list()).toEqual([
      {
        channelId: "123",
        root: "/workspace/demo",
        name: "demo",
        outsideWorkspaceAccess: true,
      },
    ]);
  });
});
