import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BashOperations, EditOperations, LsOperations, ReadOperations, WriteOperations } from "@mariozechner/pi-coding-agent";
import { createLocalBashOperations } from "@mariozechner/pi-coding-agent";
import { AccessApprovalManager } from "./access-approval.js";

export interface AccessContext {
  conversationKey: string;
  workspaceKey: string;
  sessionName?: string;
}

const DEFAULT_BLOCKED_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_ed25519",
];

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

export class WorkspaceGuard {
  private readonly blockedPatterns: string[];
  private readonly blockedRegexes: RegExp[];
  private readonly localBash = createLocalBashOperations();

  constructor(
    private readonly workspaceRoot: string,
    blockedPatterns: string[] | undefined,
    private readonly approvals: AccessApprovalManager,
  ) {
    this.blockedPatterns = blockedPatterns && blockedPatterns.length > 0
      ? blockedPatterns
      : DEFAULT_BLOCKED_PATTERNS;
    this.blockedRegexes = this.blockedPatterns.map(globToRegExp);
  }

  get root(): string {
    return this.workspaceRoot;
  }

  getBlockedPatterns(): string[] {
    return [...this.blockedPatterns];
  }

  async createReadOperations(context: AccessContext): Promise<ReadOperations> {
    return {
      access: async (absolutePath) => {
        await this.authorizePath(absolutePath, "read", context, false);
      },
      readFile: async (absolutePath) => {
        await this.authorizePath(absolutePath, "read", context, false);
        return readFile(absolutePath);
      },
      detectImageMimeType: async (absolutePath) => {
        await this.authorizePath(absolutePath, "read", context, false);
        const extension = path.extname(absolutePath).toLowerCase();
        switch (extension) {
          case ".png":
            return "image/png";
          case ".jpg":
          case ".jpeg":
            return "image/jpeg";
          case ".gif":
            return "image/gif";
          case ".webp":
            return "image/webp";
          default:
            return null;
        }
      },
    };
  }

  async createEditOperations(context: AccessContext): Promise<EditOperations> {
    return {
      access: async (absolutePath) => {
        await this.authorizePath(absolutePath, "write", context, false);
      },
      readFile: async (absolutePath) => {
        await this.authorizePath(absolutePath, "read", context, false);
        return readFile(absolutePath);
      },
      writeFile: async (absolutePath, content) => {
        await this.authorizePath(absolutePath, "write", context, true);
        await writeFile(absolutePath, content, "utf8");
      },
    };
  }

  async createWriteOperations(context: AccessContext): Promise<WriteOperations> {
    return {
      mkdir: async (dir) => {
        await this.authorizePath(dir, "write", context, true);
        await mkdir(dir, { recursive: true });
      },
      writeFile: async (absolutePath, content) => {
        await this.authorizePath(absolutePath, "write", context, true);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content, "utf8");
      },
    };
  }

  async createLsOperations(context: AccessContext): Promise<LsOperations> {
    return {
      exists: async (absolutePath) => {
        await this.authorizePath(absolutePath, "list", context, false);
        try {
          await stat(absolutePath);
          return true;
        } catch {
          return false;
        }
      },
      stat: async (absolutePath) => {
        await this.authorizePath(absolutePath, "list", context, false);
        return stat(absolutePath);
      },
      readdir: async (absolutePath) => {
        await this.authorizePath(absolutePath, "list", context, false);
        const entries = await readdir(absolutePath);
        return entries.filter((entry) => !this.isBlockedName(entry));
      },
    };
  }

  async createBashOperations(context: AccessContext): Promise<BashOperations> {
    return {
      exec: async (command, cwd, options) => {
        await this.authorizeCommand(command, context);
        return this.localBash.exec(command, cwd, options);
      },
    };
  }

  resolveInputPath(inputPath: string | undefined): string {
    return path.resolve(this.workspaceRoot, inputPath || ".");
  }

  relativeDisplayPath(absolutePath: string): string {
    const relative = path.relative(this.workspaceRoot, absolutePath);
    return relative && !relative.startsWith("..") ? relative : absolutePath;
  }

  canExposeInListing(absolutePath: string): boolean {
    const relative = path.relative(this.workspaceRoot, absolutePath);
    if (relative.startsWith("..")) return false;
    return !this.matchesBlockedPattern(relative) && !this.isBlockedName(path.basename(absolutePath));
  }

  async walkFiles(rootPath: string, limit: number): Promise<string[]> {
    const results: string[] = [];
    const stack = [rootPath];

    while (stack.length > 0 && results.length < limit) {
      const current = stack.pop();
      if (!current) continue;
      const currentStat = await stat(current);

      if (currentStat.isDirectory()) {
        const entries = await readdir(current);
        for (const entry of entries.sort().reverse()) {
          const child = path.join(current, entry);
          if (this.canExposeInListing(child)) {
            stack.push(child);
          }
        }
        continue;
      }

      if (this.canExposeInListing(current)) {
        results.push(current);
      }
    }

    return results;
  }

  async readTextFile(absolutePath: string, context: AccessContext): Promise<string | null> {
    await this.authorizePath(absolutePath, "read", context, false);
    const buffer = await readFile(absolutePath);
    if (isBinaryBuffer(buffer)) return null;
    return buffer.toString("utf8");
  }

  private isBlockedName(name: string): boolean {
    return this.blockedRegexes.some((regex) => regex.test(name));
  }

  private matchesBlockedPattern(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, "/");
    const basename = path.basename(normalized);
    return this.blockedRegexes.some((regex) => regex.test(normalized) || regex.test(basename));
  }

  private async authorizePath(
    absolutePath: string,
    accessKind: "read" | "write" | "list" | "search",
    context: AccessContext,
    allowMissing: boolean,
  ): Promise<void> {
    const workspaceReal = await realpath(this.workspaceRoot);
    const resolved = path.resolve(absolutePath);

    let targetForCheck = resolved;
    try {
      targetForCheck = await realpath(resolved);
    } catch {
      if (!allowMissing) {
        throw new Error(`Path does not exist: ${resolved}`);
      }

      const parent = path.dirname(resolved);
      targetForCheck = path.join(await realpath(parent), path.basename(resolved));
    }

    const relative = path.relative(workspaceReal, targetForCheck);
    const insideWorkspace = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    const displayPath = insideWorkspace ? relative || "." : targetForCheck;

    if (!insideWorkspace) {
      if (this.approvals.isOutsideWorkspaceAllowed(context.workspaceKey)) {
        return;
      }

      await this.approvals.request({
        conversationKey: context.conversationKey,
        workspaceKey: context.workspaceKey,
        fingerprint: `outside:${accessKind}:${targetForCheck}`,
        summary: `AI wants ${accessKind} access outside the workspace: ${targetForCheck}`,
      });
      return;
    }

    if (this.matchesBlockedPattern(displayPath)) {
      await this.approvals.request({
        conversationKey: context.conversationKey,
        workspaceKey: context.workspaceKey,
        fingerprint: `blocked:${accessKind}:${targetForCheck}`,
        summary: `AI wants ${accessKind} access to a blocked path: ${displayPath}`,
      });
    }
  }

  private async authorizeCommand(command: string, context: AccessContext): Promise<void> {
    const tokens = command.match(/(~\/[^\s'"`]+|\/[^\s'"`]+|\.\.\/[^\s'"`]+|\.\/[^\s'"`]+|\.env(?:\.[^\s'"`]+)?)/g) ?? [];

    for (const token of tokens) {
      if (token.startsWith(".env")) {
        await this.approvals.request({
          conversationKey: context.conversationKey,
          workspaceKey: context.workspaceKey,
          fingerprint: `bash-blocked:${token}`,
          summary: `AI wants to run a bash command referencing a blocked path token: ${token}`,
        });
        continue;
      }

      const absolutePath = token.startsWith("~/")
        ? path.join(process.env.HOME || this.workspaceRoot, token.slice(2))
        : path.resolve(this.workspaceRoot, token);
      await this.authorizePath(absolutePath, "search", context, true);
    }
  }
}
