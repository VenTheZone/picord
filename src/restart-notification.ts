import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RestartNotification {
  channelId: string;
  requestedByUserId: string;
  requestedByTag?: string;
  requestedAt: string;
}

export function resolveRestartNotificationPath(statePath: string): string {
  return `${path.resolve(statePath)}.restart-notification.json`;
}

export function writeRestartNotification(statePath: string, notification: RestartNotification): string {
  const notificationPath = resolveRestartNotificationPath(statePath);
  writeFileSync(notificationPath, `${JSON.stringify(notification, null, 2)}\n`, "utf8");
  return notificationPath;
}

export function readRestartNotification(statePath: string): RestartNotification | undefined {
  const notificationPath = resolveRestartNotificationPath(statePath);
  if (!existsSync(notificationPath)) {
    return undefined;
  }

  const parsed = JSON.parse(readFileSync(notificationPath, "utf8")) as Partial<RestartNotification>;
  if (typeof parsed.channelId !== "string" || typeof parsed.requestedByUserId !== "string" || typeof parsed.requestedAt !== "string") {
    throw new Error(`Invalid restart notification file: ${notificationPath}`);
  }

  return {
    channelId: parsed.channelId,
    requestedByUserId: parsed.requestedByUserId,
    requestedByTag: typeof parsed.requestedByTag === "string" ? parsed.requestedByTag : undefined,
    requestedAt: parsed.requestedAt,
  };
}

export function clearRestartNotification(statePath: string): void {
  const notificationPath = resolveRestartNotificationPath(statePath);
  if (!existsSync(notificationPath)) {
    return;
  }
  rmSync(notificationPath, { force: true });
}
