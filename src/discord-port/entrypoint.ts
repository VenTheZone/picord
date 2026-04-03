import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { startDiscordPortExtensionRuntime } from "./extension-bridge.js";

export default function discordPortExtension(pi: ExtensionAPI) {
  let stopHandle: (() => Promise<void>) | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const started = await startDiscordPortExtensionRuntime({
      pi,
      cwd: ctx.cwd,
      notify: (message, level = "info") => ctx.ui.notify(message, level),
    });
    stopHandle = started.stop;
  });

  pi.on("session_shutdown", async () => {
    if (stopHandle) {
      await stopHandle();
      stopHandle = undefined;
    }
  });
}
