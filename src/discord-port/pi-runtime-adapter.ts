import type { ApprovalDecisionMode } from "../access-approval.js";
import type { LiveDiscordRunRenderer } from "../live-discord-renderer.js";

interface RegisteredLiveRenderer {
  renderer: LiveDiscordRunRenderer;
  runId?: number;
}
import type { PiSessionPool } from "../pi-session.js";
import type { ModelSummary, PicordRuntimeConfig, SkillSummary, ThinkingLevel } from "../types.js";
import type {
  DiscordPortRuntimeAdapter,
  LoginProviderOption,
  ManagedProjectRecord,
  PiAvailableSessionSummary,
  PiBoundSessionSummary,
} from "./types.js";

export class PiSessionPoolAdapter implements DiscordPortRuntimeAdapter {
  constructor(
    public readonly config: PicordRuntimeConfig,
    private readonly sessionPool: PiSessionPool,
    private readonly liveRenderers: Map<string, RegisteredLiveRenderer>,
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

  listAllSessions(limit?: number) {
    return this.sessionPool.listAllSessions(limit);
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

  setConversationModel(conversationKey: string, workspaceKey: string, modelReference: string): Promise<ModelSummary> {
    return this.sessionPool.setConversationModel(conversationKey, workspaceKey, modelReference);
  }

  getEffectiveModel(conversationKey: string, workspaceKey: string): ModelSummary | undefined {
    return this.sessionPool.getEffectiveModel(conversationKey, workspaceKey);
  }

  setWorkspaceThinkingLevel(workspaceKey: string, thinkingLevel: ThinkingLevel): void {
    this.sessionPool.setWorkspaceThinkingLevel(workspaceKey, thinkingLevel);
  }

  setConversationThinkingLevel(conversationKey: string, workspaceKey: string, thinkingLevel: ThinkingLevel): void {
    this.sessionPool.setConversationThinkingLevel(conversationKey, workspaceKey, thinkingLevel);
  }

  getEffectiveThinkingLevel(conversationKey: string, workspaceKey: string): ThinkingLevel {
    return this.sessionPool.getEffectiveThinkingLevel(conversationKey, workspaceKey);
  }

  listLoginProviders(): LoginProviderOption[] {
    return this.sessionPool.listLoginProviders();
  }

  setProviderApiKey(providerId: string, apiKey: string): void {
    this.sessionPool.setProviderApiKey(providerId, apiKey);
  }

  startOpenAICodexLogin(userId: string): Promise<{ url: string; instructions?: string }> {
    return this.sessionPool.startOpenAICodexLogin(userId);
  }

  completeOpenAICodexLogin(userId: string, codeOrUrl: string): Promise<void> {
    return this.sessionPool.completeOpenAICodexLogin(userId, codeOrUrl);
  }

  registerLiveRenderer(conversationKey: string, renderer: LiveDiscordRunRenderer, runId?: number): void {
    this.liveRenderers.set(conversationKey, { renderer, runId });
  }

  clearLiveRenderer(conversationKey: string, renderer?: LiveDiscordRunRenderer): void {
    const current = this.liveRenderers.get(conversationKey);
    if (!current) return;
    if (renderer && current.renderer !== renderer) return;
    this.liveRenderers.delete(conversationKey);
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
    runId?: number;
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
