import type { ApprovalDecisionMode } from "../access-approval.js";
import type { PiSessionPool } from "../pi-session.js";
import type { ModelSummary, PicordRuntimeConfig, SkillSummary } from "../types.js";
import type {
  DiscordPortRuntimeAdapter,
  ManagedProjectRecord,
  PiAvailableSessionSummary,
  PiBoundSessionSummary,
} from "./types.js";

export class PiSessionPoolAdapter implements DiscordPortRuntimeAdapter {
  constructor(
    public readonly config: PicordRuntimeConfig,
    private readonly sessionPool: PiSessionPool,
  ) {}

  isOwner(userId: string): boolean {
    return this.sessionPool.isOwner(userId);
  }

  listManagedProjects(): ManagedProjectRecord[] {
    return this.sessionPool.listManagedWorkspaces();
  }

  isManagedProjectChannel(channelId: string): boolean {
    return this.sessionPool.getManagedWorkspaceChannelIds().includes(channelId)
      || Object.prototype.hasOwnProperty.call(this.config.workspaceRoots, channelId);
  }

  addManagedProject(channelId: string, root: string, name?: string): Promise<ManagedProjectRecord> {
    return this.sessionPool.addManagedWorkspace(channelId, root, name);
  }

  hasBoundSession(conversationKey: string): boolean {
    return this.sessionPool.hasSessionBinding(conversationKey);
  }

  getBoundSessionSummary(conversationKey: string): PiBoundSessionSummary | undefined {
    return this.sessionPool.getBoundSessionSummary(conversationKey);
  }

  getSessionCount(): number {
    return this.sessionPool.getSessionCount();
  }

  getSkillSummaries() {
    return this.sessionPool.getSkillSummaries();
  }

  getWorkspaceModelScope(workspaceKey: string) {
    return this.sessionPool.getWorkspaceModelScope(workspaceKey);
  }

  getAvailableModels() {
    return this.sessionPool.getAvailableModels();
  }

  getWorkspaceInfo(workspaceKey: string) {
    return this.sessionPool.getWorkspaceInfo(workspaceKey);
  }

  getBlockedPathPatterns(): string[] {
    return this.sessionPool.getBlockedPathPatterns();
  }

  listSessionsForWorkspace(workspaceKey: string, limit?: number): Promise<PiAvailableSessionSummary[]> {
    return this.sessionPool.listSessionsForWorkspace(workspaceKey, limit);
  }

  setWorkspaceModelScope(workspaceKey: string, rawPatterns: string) {
    return this.sessionPool.setWorkspaceModelScope(workspaceKey, rawPatterns);
  }

  clearWorkspaceModelScope(workspaceKey: string) {
    return this.sessionPool.clearWorkspaceModelScope(workspaceKey);
  }

  setWorkspaceModel(workspaceKey: string, modelReference: string): Promise<ModelSummary> {
    return this.sessionPool.setWorkspaceModel(workspaceKey, modelReference);
  }

  listSkillSummaries(): SkillSummary[] {
    return this.sessionPool.getSkillSummaries();
  }

  getPendingAccessRequests(workspaceKey?: string) {
    return this.sessionPool.getPendingAccessRequests(workspaceKey);
  }

  resolveAccessRequest(requestId: string, mode: ApprovalDecisionMode) {
    return this.sessionPool.resolveAccessRequest(requestId, mode);
  }

  abort(conversationKey: string): Promise<boolean> {
    return this.sessionPool.abort(conversationKey);
  }

  reset(conversationKey: string): Promise<boolean> {
    return this.sessionPool.reset(conversationKey);
  }

  async resumeSession(options: {
    conversationKey: string;
    workspaceKey: string;
    sessionName: string;
    sessionReference: string;
  }): Promise<PiBoundSessionSummary> {
    const resumed = await this.sessionPool.resumeSession(options);
    return {
      id: resumed.id,
      path: resumed.path,
      cwd: resumed.cwd,
      name: resumed.name,
    };
  }

  respond(options: {
    conversationKey: string;
    workspaceKey: string;
    sessionName: string;
    promptText: string;
  }): Promise<string> {
    return this.sessionPool.respond(options);
  }

  invokeSkill(options: {
    conversationKey: string;
    workspaceKey: string;
    sessionName: string;
    skillName: string;
    args?: string;
  }): Promise<string> {
    return this.sessionPool.invokeSkill(options);
  }
}
