import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import discordPortExtension from "./discord-port/entrypoint.js";

export default function picordExtension(pi: ExtensionAPI) {
  return discordPortExtension(pi);
}