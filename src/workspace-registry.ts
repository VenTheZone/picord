import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface WorkspaceStateFile {
  version: 3;
  workspaces: Record<string, { root: string; name?: string; outsideWorkspaceAccess?: boolean }>;
  sessions: Record<string, { sessionFile: string; workspaceKey: string }>;
}

export interface ManagedWorkspaceSummary {
  channelId: string;
  root: string;
  name?: string;
  outsideWorkspaceAccess?: boolean;
}

const EMPTY_STATE: WorkspaceStateFile = {
  version: 3,
  workspaces: {},
  sessions: {},
};

export class WorkspaceRegistry {
  private state: WorkspaceStateFile = EMPTY_STATE;

  constructor(private readonly statePath: string) {}

  load(): void {
    if (!existsSync(this.statePath)) {
      this.state = { ...EMPTY_STATE, workspaces: {} };
      return;
    }

    const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<WorkspaceStateFile>;
    this.state = {
      version: 3,
      workspaces: parsed.workspaces ?? {},
      sessions: parsed.sessions ?? {},
    };
  }

  list(): ManagedWorkspaceSummary[] {
    return Object.entries(this.state.workspaces)
      .map(([channelId, entry]) => ({
        channelId,
        root: entry.root,
        name: entry.name,
        outsideWorkspaceAccess: entry.outsideWorkspaceAccess,
      }))
      .sort((a, b) => a.channelId.localeCompare(b.channelId));
  }

  getRoot(channelId: string): string | undefined {
    return this.state.workspaces[channelId]?.root;
  }

  getChannelIds(): string[] {
    return Object.keys(this.state.workspaces);
  }

  getSessionFile(conversationKey: string): string | undefined {
    return this.state.sessions[conversationKey]?.sessionFile;
  }

  setSessionFile(conversationKey: string, sessionFile: string, workspaceKey: string): void {
    this.state.sessions[conversationKey] = { sessionFile, workspaceKey };
    this.save();
  }

  deleteSessionFile(conversationKey: string): void {
    if (!this.state.sessions[conversationKey]) return;
    delete this.state.sessions[conversationKey];
    this.save();
  }

  isOutsideWorkspaceAllowed(channelId: string): boolean {
    return Boolean(this.state.workspaces[channelId]?.outsideWorkspaceAccess);
  }

  setOutsideWorkspaceAllowed(channelId: string, allowed: boolean): void {
    const existing = this.state.workspaces[channelId];
    if (!existing) return;
    this.state.workspaces[channelId] = { ...existing, outsideWorkspaceAccess: allowed };
    this.save();
  }

  upsert(channelId: string, root: string, name?: string): ManagedWorkspaceSummary {
    const existing = this.state.workspaces[channelId];
    this.state.workspaces[channelId] = {
      root,
      name,
      outsideWorkspaceAccess: existing?.outsideWorkspaceAccess,
    };
    this.save();
    return {
      channelId,
      root,
      name,
      outsideWorkspaceAccess: existing?.outsideWorkspaceAccess,
    };
  }

  private save(): void {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2) + "\n", "utf8");
  }

  static resolveStatePath(inputPath: string): string {
    return path.resolve(inputPath);
  }
}
