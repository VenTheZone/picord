import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "./config.js";

const tempDirs: string[] = [];

function makeConfig(config: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), "picord-config-test-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "picord.config.json");
  writeFileSync(configPath, `${JSON.stringify(config)}\n`, "utf8");
  return { dir, configPath };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("sessionMode config", () => {
  it("defaults to thread mode", () => {
    const config = loadRuntimeConfig(process.cwd(), {});
    expect(config.sessionMode).toBe("thread");
  });

  it("accepts channel mode from the config file", () => {
    const { dir, configPath } = makeConfig({ sessionMode: "channel" });
    const config = loadRuntimeConfig(dir, { PICORD_CONFIG: configPath });
    expect(config.sessionMode).toBe("channel");
  });

  it("falls back to thread mode for unknown values", () => {
    const { dir, configPath } = makeConfig({ sessionMode: "unknown" });
    const config = loadRuntimeConfig(dir, { PICORD_CONFIG: configPath });
    expect(config.sessionMode).toBe("thread");
  });
});
