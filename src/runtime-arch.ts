export type PicordRuntimeArch = "legacy" | "discord-port";

export function resolveRuntimeArch(env: NodeJS.ProcessEnv = process.env): PicordRuntimeArch {
  return env.PICORD_RUNTIME_ARCH?.trim() === "legacy" ? "legacy" : "discord-port";
}

export function isDiscordPortRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveRuntimeArch(env) === "discord-port";
}
