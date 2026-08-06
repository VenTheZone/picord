import { statSync } from "node:fs";
import { loadRuntimeConfig } from "./config.js";

interface CheckResult {
  level: "pass" | "warn" | "fail";
  message: string;
}

function format(level: CheckResult["level"], message: string): string {
  const prefix = level === "pass" ? "PASS" : level === "warn" ? "WARN" : "FAIL";
  return `[${prefix}] ${message}`;
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function run(): number {
  const cwd = process.cwd();
  const config = loadRuntimeConfig(cwd, process.env);
  const results: CheckResult[] = [];

  results.push({
    level: config.configPath ? "pass" : "warn",
    message: config.configPath
      ? `Using config file: ${config.configPath}`
      : "No picord.config.json found; using defaults/env only.",
  });

  results.push({
    level: config.discordToken ? "pass" : "warn",
    message: config.discordToken
      ? "Discord token detected."
      : "PICORD_DISCORD_TOKEN is not set. Live Discord startup will stay inactive.",
  });

  results.push({
    level: isDirectory(config.cwd) ? "pass" : "fail",
    message: `Default workspace root: ${config.cwd}`,
  });

  results.push({
    level: "pass",
    message: `State path: ${config.statePath}`,
  });

  results.push({
    level: isDirectory(config.workspaceBasePath) ? "pass" : "warn",
    message: isDirectory(config.workspaceBasePath)
      ? `Managed workspace base: ${config.workspaceBasePath}`
      : `Managed workspace base: ${config.workspaceBasePath} (missing now; /project-create will create it on demand)`,
  });

  const workspaceEntries = Object.entries(config.workspaceRoots);
  if (workspaceEntries.length === 0) {
    results.push({
      level: "warn",
      message: `No static workspaceRoots configured. Managed projects created with /project-create will use ${config.workspaceBasePath}; unmapped channels/DMs still fall back to ${config.cwd}.`,
    });
  } else {
    for (const [channelId, root] of workspaceEntries) {
      results.push({
        level: isDirectory(root) ? "pass" : "fail",
        message: `workspaceRoots[${channelId}] -> ${root}`,
      });
    }
  }

  if (config.allowedChannelIds.length > 0) {
    for (const channelId of config.allowedChannelIds) {
      if (!config.workspaceRoots[channelId]) {
        results.push({
          level: "warn",
          message: `Allowed channel ${channelId} has no explicit workspaceRoots entry; it will use default cwd ${config.cwd}`,
        });
      }
    }
  }

  results.push({
    level: config.allowedRoleIds.length > 0 || config.allowedRoleNames.length > 0 || config.allowedUserIds.length > 0 ? "pass" : "warn",
    message:
      config.allowedRoleIds.length > 0 || config.allowedRoleNames.length > 0 || config.allowedUserIds.length > 0
        ? `Guild access controls configured (roleIds=${config.allowedRoleIds.length}, roleNames=${config.allowedRoleNames.length}, users=${config.allowedUserIds.length}).`
        : "No guild access roles/users configured yet. Guild usage will remain effectively restricted/awkward.",
  });

  results.push({
    level: config.ownerUserId ? "pass" : "warn",
    message: config.ownerUserId
      ? `Owner user configured: ${config.ownerUserId}`
      : "ownerUserId is not configured. Approval-gated outside-workspace access cannot be approved.",
  });

  results.push({
    level: "pass",
    message: config.hostChannelId
      ? `Host control channel: #${config.hostChannelName} (${config.hostChannelId})`
      : `Host control channel: #${config.hostChannelName}`,
  });

  results.push({
    level: config.blockedPathPatterns.length > 0 ? "pass" : "warn",
    message: `Blocked path patterns: ${config.blockedPathPatterns.join(", ") || "(none)"}`,
  });

  const hasFailures = results.some((result) => result.level === "fail");

  console.log("PICORD DOCTOR");
  console.log("=============");
  console.log(`Project dir: ${cwd}`);
  console.log(`Resolved config cwd: ${config.cwd}`);
  console.log("");
  for (const result of results) {
    console.log(format(result.level, result.message));
  }

  console.log("");
  console.log("Summary:");
  console.log(`- allowedGuildIds: ${config.allowedGuildIds.length}`);
  console.log(`- allowedChannelIds: ${config.allowedChannelIds.length}`);
  console.log(`- workspaceRoots: ${workspaceEntries.length}`);
  console.log(`- workspaceBasePath: ${config.workspaceBasePath}`);
  console.log(`- hostChannelId: ${config.hostChannelId ?? "(auto-resolve by name)"}`);
  console.log(`- hostChannelName: ${config.hostChannelName}`);
  console.log(`- toolMode: ${config.toolMode}`);
  console.log(`- thinkingLevel: ${config.thinkingLevel}`);

  if (hasFailures) {
    console.error("\nDoctor found blocking issues.");
    return 1;
  }

  console.log("\nDoctor completed without blocking issues.");
  return 0;
}

process.exitCode = run();
