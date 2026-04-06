import { stat } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AccessContext, WorkspaceGuard } from "./path-policy.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const escaped = escapeRegExp(pattern).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function toRelativeDisplay(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath).replace(/\\/g, "/");
  return relative || ".";
}

export function createSafeCustomTools(
  guard: WorkspaceGuard,
  context: AccessContext,
): ToolDefinition[] {
  const lsTool = {
    name: "ls",
    label: "ls",
    description: "List files and directories inside the workspace",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Path to list (relative to workspace)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return" })),
    }),
    execute: async (_toolCallId: string, params: { path?: string; limit?: number }) => {
      const absolutePath = guard.resolveInputPath(params.path);
      const ops = await guard.createLsOperations(context);
      const exists = await ops.exists(absolutePath);
      if (!exists) {
        throw new Error(`Path not found: ${params.path ?? "."}`);
      }

      const info = await ops.stat(absolutePath);
      if (!info.isDirectory()) {
        return {
          content: [{ type: "text", text: toRelativeDisplay(guard.root, absolutePath) }],
          details: {},
        };
      }

      const entries = await ops.readdir(absolutePath);
      const limit = Math.max(1, Math.min(params.limit ?? 200, 500));
      const lines = entries.slice(0, limit).map((entry) => {
        const child = path.join(absolutePath, entry);
        return child;
      });

      const rendered = await Promise.all(lines.map(async (entryPath) => {
        const entryStat = await stat(entryPath);
        return `${entryStat.isDirectory() ? "d" : "f"} ${toRelativeDisplay(guard.root, entryPath)}`;
      }));

      return {
        content: [{ type: "text", text: rendered.join("\n") || "(empty directory)" }],
        details: { entryCount: rendered.length },
      };
    },
  } satisfies ToolDefinition;

  const findTool = {
    name: "find",
    label: "find",
    description: "Find files inside the workspace using a glob-style pattern",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob-style filename pattern, e.g. *.ts or *config*" }),
      path: Type.Optional(Type.String({ description: "Path to search from (relative to workspace)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matches" })),
    }),
    execute: async (_toolCallId: string, params: { pattern: string; path?: string; limit?: number }) => {
      const absolutePath = guard.resolveInputPath(params.path);
      const ops = await guard.createLsOperations(context);
      const exists = await ops.exists(absolutePath);
      if (!exists) {
        throw new Error(`Path not found: ${params.path ?? "."}`);
      }

      const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
      const patternRegex = globToRegExp(params.pattern);
      const files = await guard.walkFiles(absolutePath, limit * 10);
      const matches = files
        .filter((filePath) => patternRegex.test(path.basename(filePath)))
        .slice(0, limit)
        .map((filePath) => toRelativeDisplay(guard.root, filePath));

      return {
        content: [{ type: "text", text: matches.join("\n") || "No matches found." }],
        details: { matchCount: matches.length },
      };
    },
  } satisfies ToolDefinition;

  const grepTool = {
    name: "grep",
    label: "grep",
    description: "Search text files inside the workspace",
    parameters: Type.Object({
      pattern: Type.String({ description: "Text or regex pattern to search for" }),
      path: Type.Optional(Type.String({ description: "Path to search from (relative to workspace)" })),
      glob: Type.Optional(Type.String({ description: "Optional file glob filter, e.g. *.ts" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal text" })),
      context: Type.Optional(Type.Number({ description: "Context lines around a match" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matches" })),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        pattern: string;
        path?: string;
        glob?: string;
        ignoreCase?: boolean;
        literal?: boolean;
        context?: number;
        limit?: number;
      },
    ) => {
      const absolutePath = guard.resolveInputPath(params.path);
      const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
      const contextLines = Math.max(0, Math.min(params.context ?? 0, 5));
      const filePattern = params.glob ? globToRegExp(params.glob) : null;
      const flags = params.ignoreCase ? "gi" : "g";
      const matcher = params.literal
        ? new RegExp(escapeRegExp(params.pattern), params.ignoreCase ? "i" : "")
        : new RegExp(params.pattern, params.ignoreCase ? "i" : "");

      const files = await guard.walkFiles(absolutePath, limit * 10);
      const matches: string[] = [];

      for (const filePath of files) {
        if (matches.length >= limit) break;
        if (filePattern && !filePattern.test(path.basename(filePath))) continue;

        const text = await guard.readTextFile(filePath, context);
        if (text === null) continue;

        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index] ?? "";
          const doesMatch = params.literal
            ? matcher.test(line)
            : new RegExp(matcher.source, flags).test(line);
          if (!doesMatch) continue;

          const start = Math.max(0, index - contextLines);
          const end = Math.min(lines.length, index + contextLines + 1);
          const snippet = lines
            .slice(start, end)
            .map((value, offset) => `${start + offset + 1}: ${value}`)
            .join("\n");
          matches.push(`${toRelativeDisplay(guard.root, filePath)}\n${snippet}`);
          if (matches.length >= limit) break;
        }
      }

      return {
        content: [{ type: "text", text: matches.join("\n\n") || "No matches found." }],
        details: { matchCount: matches.length },
      };
    },
  } satisfies ToolDefinition;

  return [lsTool, findTool, grepTool];
}
