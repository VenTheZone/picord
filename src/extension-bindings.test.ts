import { describe, expect, it, vi } from "vitest";
import {
  createDiscordExtensionBindings,
  createDiscordExtensionUIContext,
  formatExtensionError,
  notifyExtensionBindingFailure,
} from "./extension-bindings.js";

describe("extension-bindings", () => {
  it("formats extension errors with source context", () => {
    expect(formatExtensionError({
      extensionPath: "/ext/mcp.ts",
      event: "session_start",
      error: "boom",
    })).toBe("Extension error in /ext/mcp.ts during session_start: boom");
  });

  it("emits Discord-safe notifications for extension ui alerts", async () => {
    const notifyLiveUpdate = vi.fn(async () => undefined);
    const ui = createDiscordExtensionUIContext({
      conversationKey: "conv-1",
      notifyLiveUpdate,
    });

    ui.notify("MCP connected", "info");
    await vi.waitFor(() => expect(notifyLiveUpdate).toHaveBeenCalledTimes(1));
    expect(notifyLiveUpdate).toHaveBeenCalledWith("conv-1", undefined, {
      type: "assistant_delta",
      delta: "\n\nℹ️ MCP connected",
    });
  });

  it("reports extension runner errors back into the Discord session", async () => {
    const notifyLiveUpdate = vi.fn(async () => undefined);
    const bindings = createDiscordExtensionBindings({
      conversationKey: "conv-2",
      notifyLiveUpdate,
    });

    bindings.onError?.({
      extensionPath: "/ext/mcp.ts",
      event: "session_start",
      error: "failed to connect",
    });

    await vi.waitFor(() => expect(notifyLiveUpdate).toHaveBeenCalledTimes(1));
    expect(notifyLiveUpdate).toHaveBeenCalledWith("conv-2", undefined, {
      type: "assistant_delta",
      delta: "\n\n❌ Extension error in /ext/mcp.ts during session_start: failed to connect",
    });
  });

  it("reports bindExtensions failures without crashing the session", async () => {
    const notifyLiveUpdate = vi.fn(async () => undefined);

    await notifyExtensionBindingFailure({
      conversationKey: "conv-3",
      notifyLiveUpdate,
    }, new Error("extension init exploded"));

    expect(notifyLiveUpdate).toHaveBeenCalledWith("conv-3", undefined, {
      type: "assistant_delta",
      delta: "\n\n❌ Failed to initialize session extensions: extension init exploded",
    });
  });
});
