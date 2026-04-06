import type { AgentSession, ExtensionError, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { PiLiveUpdate } from "./live-discord-renderer.js";

type SessionExtensionBindings = Parameters<AgentSession["bindExtensions"]>[0];
type NotificationLevel = "info" | "warning" | "error";

interface ExtensionBindingOptions {
  conversationKey: string;
  notifyLiveUpdate?: (conversationKey: string, runId: number | undefined, update: PiLiveUpdate) => Promise<void>;
  onLog?: (level: NotificationLevel, message: string) => void;
}

const DISCORD_SAFE_THEME = {} as Theme;

function formatNotificationPrefix(level: NotificationLevel): string {
  switch (level) {
    case "error":
      return "❌";
    case "warning":
      return "⚠️";
    default:
      return "ℹ️";
  }
}

async function emitNotification(
  options: ExtensionBindingOptions,
  level: NotificationLevel,
  message: string,
): Promise<void> {
  options.onLog?.(level, message);
  if (!options.notifyLiveUpdate) {
    return;
  }

  await options.notifyLiveUpdate(options.conversationKey, undefined, {
    type: "assistant_delta",
    delta: `\n\n${formatNotificationPrefix(level)} ${message}`,
  });
}

export function formatExtensionError(error: ExtensionError): string {
  return `Extension error in ${error.extensionPath} during ${error.event}: ${error.error}`;
}

export function createDiscordExtensionUIContext(options: ExtensionBindingOptions): ExtensionUIContext {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message, type = "info") => {
      void emitNotification(options, type, message);
    },
    onTerminalInput: () => () => undefined,
    setStatus: () => undefined,
    setWorkingMessage: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    custom: async () => undefined as never,
    pasteToEditor: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => "",
    editor: async () => undefined,
    setEditorComponent: () => undefined,
    theme: DISCORD_SAFE_THEME,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching is not supported in Discord sessions." }),
    getToolsExpanded: () => true,
    setToolsExpanded: () => undefined,
  };
}

export function createDiscordExtensionBindings(options: ExtensionBindingOptions): SessionExtensionBindings {
  return {
    uiContext: createDiscordExtensionUIContext(options),
    onError: (error) => {
      void emitNotification(options, "error", formatExtensionError(error));
    },
  };
}

export async function notifyExtensionBindingFailure(
  options: ExtensionBindingOptions,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await emitNotification(options, "error", `Failed to initialize session extensions: ${message}`);
}
