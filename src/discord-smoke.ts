import { Client, GatewayIntentBits } from "discord.js";
import { loadRuntimeConfig } from "./config.js";
import { buildDiscordPortCommands } from "./discord-port/command-registration.js";
import { PiSessionPool } from "./pi-session.js";
import { resolveRuntimeArch } from "./runtime-arch.js";

async function loginWithFallback(config: ReturnType<typeof loadRuntimeConfig>): Promise<{
  client: Client;
  slashOnlyMode: boolean;
}> {
  const createClient = (enableMessageContent: boolean) =>
    new Client({
      intents: enableMessageContent
        ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
        : [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    });

  let client = createClient(true);
  try {
    await client.login(config.discordToken);
    return { client, slashOnlyMode: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Used disallowed intents")) {
      throw error;
    }

    try {
      await client.destroy();
    } catch {}

    client = createClient(false);
    await client.login(config.discordToken);
    return { client, slashOnlyMode: true };
  }
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig(process.cwd(), process.env);
  const runtimeArch = resolveRuntimeArch(process.env);

  if (!config.discordToken) {
    throw new Error("PICORD_DISCORD_TOKEN is not set.");
  }

  const guildId = config.allowedGuildIds[0];
  if (!guildId) {
    throw new Error("No allowedGuildIds configured in picord.config.json.");
  }

  const sessionPool = new PiSessionPool(config, async () => undefined);
  await sessionPool.initialize();

  let client: Client | undefined;
  try {
    const login = await loginWithFallback(config);
    client = login.client;
    const slashOnlyMode = login.slashOnlyMode;
    const app = await client.application?.fetch();
    const guild = await client.guilds.fetch(guildId);
    const fullGuild = await guild.fetch();
    await fullGuild.roles.fetch();
    const me = await fullGuild.members.fetchMe();

    const perms = me.permissions;

    if (perms.has("ManageRoles")) {
      for (const roleName of config.allowedRoleNames) {
        const existing = fullGuild.roles.cache.find((entry) => entry.name === roleName);
        if (!existing) {
          await fullGuild.roles.create({
            name: roleName,
            reason: "picord smoke test auto-created configured access role",
            mentionable: false,
            hoist: false,
          });
        }
      }
      await fullGuild.roles.fetch();
    }

    const matchedRolesByName = config.allowedRoleNames.map((name) => {
      const role = fullGuild.roles.cache.find((entry) => entry.name === name);
      return { name, id: role?.id };
    });

    console.log("DISCORD SMOKE TEST");
    console.log("==================");
    console.log(`Runtime architecture: ${runtimeArch}`);
    console.log(`Bot user: ${client.user?.tag} (${client.user?.id})`);
    console.log(`Application: ${app?.name ?? "unknown"} (${app?.id ?? "unknown"})`);
    console.log(`Guild: ${fullGuild.name} (${fullGuild.id})`);
    console.log(`Configured owner: ${config.ownerUserId ?? "(none)"}`);
    console.log(`Allowed role names: ${config.allowedRoleNames.join(", ") || "(none)"}`);
    console.log(
      `Resolved role IDs: ${matchedRolesByName.map((entry) => `${entry.name}:${entry.id ?? "NOT_FOUND"}`).join(", ") || "(none)"}`,
    );
    console.log(`ManageChannels: ${perms.has("ManageChannels")}`);
    console.log(`ViewChannel: ${perms.has("ViewChannel")}`);
    console.log(`SendMessages: ${perms.has("SendMessages")}`);
    console.log(`SendMessagesInThreads: ${perms.has("SendMessagesInThreads")}`);
    console.log(`CreatePublicThreads: ${perms.has("CreatePublicThreads")}`);
    console.log(`ManageThreads: ${perms.has("ManageThreads")}`);
    console.log(`ReadMessageHistory: ${perms.has("ReadMessageHistory")}`);
    console.log(`UseApplicationCommands: ${perms.has("UseApplicationCommands")}`);
    console.log(`SlashOnlyMode: ${slashOnlyMode}`);
    console.log(`MessageContentIntentRequested: ${!slashOnlyMode}`);

    const guildCommands = await client.application?.commands.fetch({ guildId: fullGuild.id });
    console.log(`Existing guild commands: ${guildCommands?.size ?? 0}`);

    const failures: string[] = [];
    if (runtimeArch === "discord-port") {
      const expectedCommands = buildDiscordPortCommands(sessionPool.getSkillSummaries()).map((command) => command.name).sort();
      const actualCommands = [...(guildCommands?.values() ?? [])].map((command) => command.name).sort();
      const missingCommands = expectedCommands.filter((name) => !actualCommands.includes(name));
      console.log(`Expected staged guild commands: ${expectedCommands.length}`);
      console.log(`Missing staged guild commands: ${missingCommands.join(", ") || "(none)"}`);
      if (missingCommands.length > 0) {
        failures.push(`Missing staged guild commands: ${missingCommands.join(", ")}. Run npm run sync:discord-commands after updating commands or skills.`);
      }
    }
    if (!matchedRolesByName.every((entry) => entry.id)) {
      failures.push("One or more configured allowedRoleNames could not be resolved in the guild.");
    }
    if (!perms.has("ManageChannels")) {
      failures.push("Bot is missing ManageChannels, which is needed for /project-create.");
    }
    if (!perms.has("SendMessages")) {
      failures.push("Bot is missing SendMessages.");
    }
    if (!perms.has("SendMessagesInThreads")) {
      failures.push("Bot is missing SendMessagesInThreads, which is needed for thread replies.");
    }
    if (!perms.has("CreatePublicThreads")) {
      failures.push("Bot is missing CreatePublicThreads, which is needed for auto-started session threads.");
    }
    if (!perms.has("ReadMessageHistory")) {
      failures.push("Bot is missing ReadMessageHistory.");
    }
    if (!perms.has("UseApplicationCommands")) {
      failures.push("Bot is missing UseApplicationCommands.");
    }

    if (failures.length > 0) {
      console.log("\nFAILURES:");
      for (const failure of failures) {
        console.log(`- ${failure}`);
      }
      process.exitCode = 1;
      return;
    }

    if (slashOnlyMode) {
      console.log("\nSmoke test passed in slash-only mode (Message Content intent unavailable).");
      return;
    }

    console.log("\nSmoke test passed.");
  } finally {
    if (client) {
      await client.destroy();
    }
    await sessionPool.dispose();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
