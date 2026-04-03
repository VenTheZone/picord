import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface WorkspaceStateFile {
  version: 2;
  workspaces: Record<string, { root: string; name?: string }>;
  sessions: Record<string, { sessionFile: string; workspaceKey: string }>;
}

export interface ManagedWorkspaceSummary {
  channelId: string;
  root: string;
  name?: string;
}

const EMPTY_STATE: WorkspaceStateFile = {
  version: 2,
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
      version: 2,
      workspaces: parsed.workspaces ?? {},
      sessions: parsed.sessions ?? {},
    };
  }

  list(): ManagedWorkspaceSummary[] {
    return Object.entries(this.state.workspaces)
      .map(([channelId, entry]) => ({ channelId, root: entry.root, name: entry.name }))
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

  upsert(channelId: string, root: string, name?: string): ManagedWorkspaceSummary {
    this.state.workspaces[channelId] = { root, name };
    this.save();
    return { channelId, root, name };
  }

  private save(): void {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2) + "\n", "utf8");
  }

  static resolveStatePath(inputPath: string): string {
    return path.resolve(inputPath);
  }
}
