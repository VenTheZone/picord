import { Client, GatewayIntentBits } from "discord.js";
import path from "node:path";
import { loadRuntimeConfig } from "./config.js";
import { buildDiscordPortCommands } from "./discord-port/command-registration.js";
import { buildAllMultiAuthCommands } from "./discord-port/multi-auth-commands.js";
import { PiSessionPool } from "./pi-session.js";
import { initMultiAuthConfig } from "./multi-auth/multi-auth-config.js";
import { buildMultiAuthExtensionConfig } from "./multi-auth/picord-config-adapter.js";
import { AccountManager } from "./discord-port/multi-auth-integration.js";
import type { SupportedProviderId } from "./multi-auth/index-export.js";


async function main(): Promise<void> {
  const config = loadRuntimeConfig(process.cwd(), process.env);

  if (!config.discordToken) {
    throw new Error("PICORD_DISCORD_TOKEN is not set.");
  }

  const sessionPool = new PiSessionPool(config, async () => undefined);
  await sessionPool.initialize();

  // Initialize multi-auth if enabled to discover providers
  let providerList: SupportedProviderId[] = [];
  if (config.multiAuth?.enabled !== false) {
    try {
      const stateDir = path.dirname(config.statePath);
      initMultiAuthConfig(config.statePath, stateDir);
      const maConfig = buildMultiAuthExtensionConfig(config.multiAuth ?? {});
      const maAccountManager = new AccountManager(undefined, undefined, undefined, undefined, undefined, maConfig);
      await maAccountManager.ensureInitialized();
      const allProviders = await maAccountManager.getSupportedProviders();
      const excludeSet = new Set(config.multiAuth?.excludeProviders ?? []);
      providerList = allProviders.filter(p => !excludeSet.has(p));
      // No need to shut down explicitly; script will exit
    } catch (err) {
      console.error("Failed to initialize multi-auth for command sync:", err);
      // proceed without provider choices
    }
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  try {
    await client.login(config.discordToken);
    await client.application?.fetch();

    if (!client.application) {
      throw new Error("Discord application metadata is unavailable after login.");
    }

    const commands = [
      ...buildDiscordPortCommands(sessionPool.getSkillSummaries()),
      ...buildAllMultiAuthCommands(providerList),
    ];

    console.log("PICORD COMMAND SYNC");
    console.log("===================");
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
