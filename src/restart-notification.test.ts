import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRestartNotification,
  readRestartNotification,
  resolveRestartNotificationPath,
  writeRestartNotification,
} from "./restart-notification.js";

const tempDirs: string[] = [];

function createTempStatePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "picord-restart-notify-"));
  tempDirs.push(dir);
  return path.join(dir, "picord.state.json");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("restart-notification", () => {
  it("persists and reloads restart notifications next to the state file", () => {
    const statePath = createTempStatePath();
    const notificationPath = writeRestartNotification(statePath, {
      channelId: "channel-1",
      requestedByUserId: "user-1",
      requestedByTag: "Luxia#0001",
      requestedAt: "2026-04-06T05:00:00.000Z",
    });

    expect(notificationPath).toBe(resolveRestartNotificationPath(statePath));
    expect(readRestartNotification(statePath)).toEqual({
      channelId: "channel-1",
      requestedByUserId: "user-1",
      requestedByTag: "Luxia#0001",
      requestedAt: "2026-04-06T05:00:00.000Z",
    });
  });

  it("clears persisted restart notifications", () => {
    const statePath = createTempStatePath();
    writeRestartNotification(statePath, {
      channelId: "channel-2",
      requestedByUserId: "user-2",
      requestedAt: "2026-04-06T05:00:00.000Z",
    });

    clearRestartNotification(statePath);

    expect(readRestartNotification(statePath)).toBeUndefined();
  });
});
