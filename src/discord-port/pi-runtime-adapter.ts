import { spawn } from "node:child_process";
import path from "node:path";
import { homedir } from "node:os";
import type { ApprovalDecisionMode } from "../access-approval.js";
import type { LiveDiscordRunRenderer } from "../live-discord-renderer.js";
import { writeRestartNotification } from "../restart-notification.js";

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

  startProviderOAuthLogin(providerId: string, userId: string): Promise<{ url: string; instructions?: string; pendingPrompt?: { message: string; placeholder?: string; allowEmpty?: boolean } }> {
    return this.sessionPool.startProviderOAuthLogin(providerId, userId);
  }

  getPendingOAuthPrompt(providerId: string, userId: string) {
    return this.sessionPool.getPendingOAuthPrompt(providerId, userId);
  }

  submitProviderOAuthPrompt(providerId: string, userId: string, input: string): void {
    this.sessionPool.submitProviderOAuthPrompt(providerId, userId, input);
  }

  completeProviderOAuthLogin(providerId: string, userId: string, codeOrUrl: string): Promise<void> {
    return this.sessionPool.completeProviderOAuthLogin(providerId, userId, codeOrUrl);
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

  async restartRuntime(options?: { notifyChannelId?: string; requestedByUserId?: string; requestedByTag?: string }): Promise<void> {
    if (options?.notifyChannelId && options.requestedByUserId) {
      writeRestartNotification(this.config.statePath, {
        channelId: options.notifyChannelId,
        requestedByUserId: options.requestedByUserId,
        requestedByTag: options.requestedByTag,
        requestedAt: new Date().toISOString(),
      });
    }

    const home = homedir();
    const startScript = path.join(home, ".picord", "picord-start.sh");
    const syncScript = path.join(home, ".picord", "picord-sync.sh");
    const logFile = path.join(home, ".picord", "picord-restart.log");
    const command = `sleep 2; tmux kill-session -t picord 2>/dev/null || true; ${syncScript} >> ${logFile} 2>&1; tmux new-session -d -s picord '${startScript}'`;
    const child = spawn("bash", ["-lc", `nohup bash -lc ${JSON.stringify(command)} >> ${JSON.stringify(logFile)} 2>&1 &`], {
      detached: true,
      stdio: "ignore",
      cwd: this.config.cwd,
    });
    child.unref();
  }

  getPendingAccessRequests(workspaceKey?: string) {
    return this.sessionPool.getPendingAccessRequests(workspaceKey);
  }

  isOutsideWorkspaceAllowed(workspaceKey: string): boolean {
    return this.sessionPool.isOutsideWorkspaceAllowed(workspaceKey);
  }

  setOutsideWorkspaceAllowed(workspaceKey: string, allowed: boolean): void {
    this.sessionPool.setOutsideWorkspaceAllowed(workspaceKey, allowed);
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

  restartSession(conversationKey: string, workspaceKey: string): Promise<boolean> {
    return this.sessionPool.restartSession(conversationKey, workspaceKey);
  }

  compactSession(conversationKey: string, _?: string): Promise<boolean> {
    return this.sessionPool
      .compact({ conversationKey })
      .then((result) => result !== undefined)
      .catch(() => false);
  }

  getAutoCompactionEnabled(conversationKey: string): boolean {
    return this.sessionPool.getAutoCompactionEnabled(conversationKey);
  }

  setAutoCompactionEnabled(conversationKey: string, enabled: boolean): void {
    return this.sessionPool.setAutoCompactionEnabled(conversationKey, enabled);
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
    runId?: number;
  }): Promise<string> {
    return this.sessionPool.invokeSkill(options);
  }
}
