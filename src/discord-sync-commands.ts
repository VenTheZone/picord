import { Client, GatewayIntentBits } from "discord.js";
import { loadRuntimeConfig } from "./config.js";
import { buildDiscordPortCommands } from "./discord-port/command-registration.js";
import { PiSessionPool } from "./pi-session.js";
import { resolveRuntimeArch } from "./runtime-arch.js";

async function main(): Promise<void> {
  const config = loadRuntimeConfig(process.cwd(), process.env);
  const runtimeArch = resolveRuntimeArch(process.env);

  if (runtimeArch !== "discord-port") {
    throw new Error("Command sync currently supports the discord-port runtime only.");
  }

  if (!config.discordToken) {
    throw new Error("PICORD_DISCORD_TOKEN is not set.");
  }

  const sessionPool = new PiSessionPool(config, async () => undefined);
  await sessionPool.initialize();

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  try {
    await client.login(config.discordToken);
    await client.application?.fetch();

    if (!client.application) {
      throw new Error("Discord application metadata is unavailable after login.");
    }

    const commands = buildDiscordPortCommands(sessionPool.getSkillSummaries());

    console.log("PICORD COMMAND SYNC");
    console.log("===================");
    console.log(`Runtime architecture: ${runtimeArch}`);
    console.log(`Application: ${client.application.name ?? "unknown"} (${client.application.id ?? "unknown"})`);
    console.log(`Commands to register: ${commands.length}`);

    if (config.allowedGuildIds.length > 0) {
      for (const guildId of config.allowedGuildIds) {
        await client.application.commands.set(commands, guildId);
        const registered = await client.application.commands.fetch({ guildId });
        console.log(`Guild ${guildId}: ${registered.size} commands registered`);
      }
    } else {
      await client.application.commands.set(commands);
      const registered = await client.application.commands.fetch();
      console.log(`Global commands registered: ${registered.size}`);
    }

    console.log("Command sync completed.");
  } finally {
    await client.destroy().catch(() => undefined);
    await sessionPool.dispose();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
