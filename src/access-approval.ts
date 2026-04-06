export type ApprovalDecisionMode = "once" | "always" | "deny";

export interface AccessRequestInput {
  conversationKey: string;
  workspaceKey: string;
  summary: string;
  fingerprint: string;
}

export interface AccessRequest {
  id: string;
  conversationKey: string;
  workspaceKey: string;
  summary: string;
  fingerprint: string;
  createdAt: number;
  sessionKey: string;
}

interface PendingRequest {
  request: AccessRequest;
  resolve: (allowed: boolean) => void;
}

function getOutsideWorkspaceAliases(workspaceKey: string): string[] {
  const normalized = workspaceKey.trim();
  if (!normalized) {
    return [];
  }

  const channelId = normalized.split(":").pop() ?? normalized;
  return [...new Set([
    normalized,
    channelId,
    `managed:${channelId}`,
  ])];
}

export class AccessApprovalManager {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly alwaysAllowed = new Set<string>();
  private readonly alwaysDenied = new Set<string>();
  private readonly outsideWorkspaceAllowed = new Set<string>();
  private requestCounter = 0;

  constructor(
    private readonly ownerUserId: string | undefined,
    private readonly notify: (conversationKey: string, content: string) => Promise<void>,
  ) {}

  isOwner(userId: string): boolean {
    return Boolean(this.ownerUserId && userId === this.ownerUserId);
  }

  getPendingRequests(workspaceKey?: string): AccessRequest[] {
    return [...this.pending.values()]
      .map((entry) => entry.request)
      .filter((request) => !workspaceKey || request.workspaceKey === workspaceKey)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  isOutsideWorkspaceAllowed(workspaceKey: string): boolean {
    return getOutsideWorkspaceAliases(workspaceKey)
      .some((alias) => this.outsideWorkspaceAllowed.has(alias));
  }

  setOutsideWorkspaceAllowed(workspaceKey: string, allowed: boolean): void {
    for (const alias of getOutsideWorkspaceAliases(workspaceKey)) {
      if (allowed) {
        this.outsideWorkspaceAllowed.add(alias);
        continue;
      }
      this.outsideWorkspaceAllowed.delete(alias);
    }
  }

  async request(input: AccessRequestInput): Promise<void> {
    if (this.alwaysAllowed.has(input.fingerprint)) {
      return;
    }

    if (this.alwaysDenied.has(input.fingerprint)) {
      throw new Error(`Access denied by owner policy: ${input.summary}`);
    }

    if (!this.ownerUserId) {
      throw new Error(
        `Access requires owner approval, but ownerUserId is not configured: ${input.summary}`,
      );
    }

    const id = `acc-${++this.requestCounter}`;
    const request: AccessRequest = {
      id,
      conversationKey: input.conversationKey,
      workspaceKey: input.workspaceKey,
      summary: input.summary,
      fingerprint: input.fingerprint,
      createdAt: Date.now(),
      sessionKey: `${input.workspaceKey}:${input.fingerprint}`,
    };

    const promise = new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        request,
        resolve: (allowed) => {
          if (allowed) resolve();
          else reject(new Error(`Access denied by owner: ${input.summary}`));
        },
      });
    });

    await this.notify(
      input.conversationKey,
      [
        "Permission request",
        `Request ID: ${id}`,
        `Requested action: ${input.summary}`,
        "Use the buttons below to approve or deny.",
      ].join("\n"),
    );

    return promise;
  }

  resolveRequest(requestId: string, mode: ApprovalDecisionMode): AccessRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;

    this.pending.delete(requestId);

    if (mode === "always") {
      this.alwaysAllowed.add(pending.request.fingerprint);
      pending.resolve(true);
      return pending.request;
    }

    if (mode === "once") {
      pending.resolve(true);
      return pending.request;
    }

    this.alwaysDenied.add(pending.request.fingerprint);
    pending.resolve(false);
    return pending.request;
  }
}
