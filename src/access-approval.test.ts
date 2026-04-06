import { describe, expect, it } from "vitest";
import { AccessApprovalManager } from "./access-approval.js";

describe("AccessApprovalManager", () => {
  it("treats outside-workspace approvals as project-scoped aliases", () => {
    const approvals = new AccessApprovalManager("owner", async () => undefined);

    approvals.setOutsideWorkspaceAllowed("discord:guild:guild-1:workspace:channel-1", true);

    expect(approvals.isOutsideWorkspaceAllowed("discord:guild:guild-1:workspace:channel-1")).toBe(true);
    expect(approvals.isOutsideWorkspaceAllowed("managed:channel-1")).toBe(true);
    expect(approvals.isOutsideWorkspaceAllowed("channel-1")).toBe(true);
  });

  it("lets persisted channel-based approvals satisfy discord workspace keys after restart", () => {
    const approvals = new AccessApprovalManager("owner", async () => undefined);

    approvals.setOutsideWorkspaceAllowed("channel-2", true);

    expect(approvals.isOutsideWorkspaceAllowed("discord:guild:guild-9:workspace:channel-2")).toBe(true);

    approvals.setOutsideWorkspaceAllowed("discord:guild:guild-9:workspace:channel-2", false);

    expect(approvals.isOutsideWorkspaceAllowed("channel-2")).toBe(false);
    expect(approvals.isOutsideWorkspaceAllowed("managed:channel-2")).toBe(false);
  });
});
