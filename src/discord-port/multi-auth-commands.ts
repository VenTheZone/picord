import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type {
	AccountManager,
	ProviderStatus,
	SupportedProviderId,
} from "../multi-auth/index-export.js";

const MAX_FIELD_VALUE_LENGTH = 1024;

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

export function buildMultiAuthStatusCommand(_providers: SupportedProviderId[] = []): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("multi-auth")
    .setDescription("Manage multi-auth credentials and rotation")
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Show credential status for all or a specific provider"),
    )
    .addSubcommand((sub) =>
      sub.setName("usage").setDescription("Show usage/quota for all or a specific provider credential"),
    )
    .addSubcommand((sub) => sub.setName("health").setDescription("Show credential health scores"))
    .toJSON();
}

export function buildMultiAuthAddApikeyCommand(providers: SupportedProviderId[] = []): RESTPostAPIChatInputApplicationCommandsJSONBody {
  const builder = new SlashCommandBuilder()
    .setName("multi-auth-add-apikey")
    .setDescription("Add an API key credential")
    .addStringOption((o) => {
      const opt = o.setName("provider").setDescription("Provider id, e.g. anthropic, openai-codex").setRequired(true);
      if (providers.length > 0) {
        const choices = providers.slice(0, 25).map((p) => ({ name: p, value: p }));
        opt.addChoices(...choices);
      }
      return opt;
    })
    .addStringOption((o) => o.setName("key").setDescription("The API key").setRequired(true))
    .addStringOption((o) => o.setName("name").setDescription("Optional friendly name for the credential").setRequired(false));
  return builder.toJSON();
}

export function buildMultiAuthDeleteCommand(providers: SupportedProviderId[] = []): RESTPostAPIChatInputApplicationCommandsJSONBody {
  const builder = new SlashCommandBuilder()
    .setName("multi-auth-delete")
    .setDescription("Delete credential(s)")
    .addStringOption((o) => {
      const opt = o.setName("provider").setDescription("Provider id").setRequired(true);
      if (providers.length > 0) {
        const choices = providers.slice(0, 25).map((p) => ({ name: p, value: p }));
        opt.addChoices(...choices);
      }
      return opt;
    })
    .addStringOption((o) => o.setName("credential").setDescription("Credential ID to delete").setRequired(true));
  return builder.toJSON();
}

export function buildMultiAuthSwitchCommand(providers: SupportedProviderId[] = []): RESTPostAPIChatInputApplicationCommandsJSONBody {
  const builder = new SlashCommandBuilder()
    .setName("multi-auth-switch")
    .setDescription("Switch the active credential for a provider")
    .addStringOption((o) => {
      const opt = o.setName("provider").setDescription("Provider id").setRequired(true);
      if (providers.length > 0) {
        const choices = providers.slice(0, 25).map((p) => ({ name: p, value: p }));
        opt.addChoices(...choices);
      }
      return opt;
    })
    .addIntegerOption((o) => o.setName("index").setDescription("Credential index (0-based)").setRequired(true));
  return builder.toJSON();
}

export function buildMultiAuthAutoCommand(providers: SupportedProviderId[] = []): RESTPostAPIChatInputApplicationCommandsJSONBody {
  const builder = new SlashCommandBuilder()
    .setName("multi-auth-auto")
    .setDescription("Return a provider to automatic credential rotation")
    .addStringOption((o) => {
      const opt = o.setName("provider").setDescription("Provider id").setRequired(true);
      if (providers.length > 0) {
        const choices = providers.slice(0, 25).map((p) => ({ name: p, value: p }));
        opt.addChoices(...choices);
      }
      return opt;
    });
  return builder.toJSON();
}

export function buildMultiAuthRenameCommand(providers: SupportedProviderId[] = []): RESTPostAPIChatInputApplicationCommandsJSONBody {
  const builder = new SlashCommandBuilder()
    .setName("multi-auth-rename")
    .setDescription("Set a friendly name for a credential")
    .addStringOption((o) => {
      const opt = o.setName("provider").setDescription("Provider id").setRequired(true);
      if (providers.length > 0) {
        const choices = providers.slice(0, 25).map((p) => ({ name: p, value: p }));
        opt.addChoices(...choices);
      }
      return opt;
    })
    .addStringOption((o) => o.setName("credential").setDescription("Credential ID").setRequired(true))
    .addStringOption((o) => o.setName("name").setDescription("Friendly display name").setRequired(true));
  return builder.toJSON();
}

export function buildMultiAuthRotationCommand(providers: SupportedProviderId[] = []): RESTPostAPIChatInputApplicationCommandsJSONBody {
  const builder = new SlashCommandBuilder()
    .setName("multi-auth-rotation")
    .setDescription("Set the rotation mode for a provider")
    .addStringOption((o) => {
      const opt = o.setName("provider").setDescription("Provider id").setRequired(true);
      if (providers.length > 0) {
        const choices = providers.slice(0, 25).map((p) => ({ name: p, value: p }));
        opt.addChoices(...choices);
      }
      return opt;
    })
    .addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("Rotation strategy")
        .setRequired(true)
        .addChoices(
          { name: "round-robin", value: "round-robin" },
          { name: "usage-based", value: "usage-based" },
          { name: "balancer (health)", value: "balancer" },
        ),
    );
  return builder.toJSON();
}

export function buildMultiAuthHideCommand(providers: SupportedProviderId[] = []): RESTPostAPIChatInputApplicationCommandsJSONBody {
  const builder = new SlashCommandBuilder()
    .setName("multi-auth-hide")
    .setDescription("Hide or unhide a provider from status output")
    .addStringOption((o) => {
      const opt = o.setName("provider").setDescription("Provider id").setRequired(true);
      if (providers.length > 0) {
        const choices = providers.slice(0, 25).map((p) => ({ name: p, value: p }));
        opt.addChoices(...choices);
      }
      return opt;
    })
    .addBooleanOption((o) => o.setName("hidden").setDescription("Whether to hide (default true)").setRequired(false));
  return builder.toJSON();
}

export function buildAllMultiAuthCommands(providers: SupportedProviderId[] = []): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [
    buildMultiAuthStatusCommand(providers),
    // Note: /multi-auth-add-apikey removed; use /login instead
    buildMultiAuthDeleteCommand(providers),
    buildMultiAuthSwitchCommand(providers),
    buildMultiAuthAutoCommand(providers),
    buildMultiAuthRenameCommand(providers),
    buildMultiAuthRotationCommand(providers),
    buildMultiAuthHideCommand(providers),
  ];
}

// ---------------------------------------------------------------------------
// Embed helpers
// ---------------------------------------------------------------------------

function truncate(val: string, max = MAX_FIELD_VALUE_LENGTH): string {
  return val.length <= max ? val : val.slice(0, max - 1) + "…";
}

function buildStatusEmbed(statuses: ProviderStatus[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Multi-Auth Status")
    .setColor(0x5865f2)
    .setTimestamp();

  for (const provider of statuses) {
    const fields: { name: string; value: string; inline: boolean }[] = [];
    for (const cred of provider.credentials) {
      const active = cred.isActive ? " 🔵" : "";
      const manual = cred.isManualActive ? " 📌" : "";
      const expiry = cred.expiresAt
        ? ` · expires ${new Date(cred.expiresAt).toLocaleString()}`
        : "";
      const usage = ` · used ${cred.usageCount}x${cred.quotaErrorCount > 0 ? ` · ❌ ${cred.quotaErrorCount} quota errors` : ""}`;
      const line = `\`${cred.credentialId}\`${active}${manual} — ${cred.friendlyName ?? cred.redactedSecret}${expiry}${usage}`;
      fields.push({ name: `—`, value: truncate(line, 1024), inline: false });
    }

    embed.addFields({
      name: `${provider.provider} (mode: ${provider.rotationMode}, active: ${provider.activeIndex + 1}/${provider.credentials.length})`,
      value: truncate(fields.map((f) => f.value).join("\n"), 4096) || "(no credentials)",
      inline: false,
    });
  }

  return embed;
}

function buildUsageEmbed(usageMap: Record<string, string>): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Credential Usage / Quota")
    .setColor(0x5865f2)
    .setTimestamp();

  for (const [key, value] of Object.entries(usageMap)) {
    embed.addFields({ name: key, value: truncate(value), inline: false });
  }

  return embed;
}

function buildHealthEmbed(healthData: Record<string, string>): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Credential Health Scores")
    .setColor(0x5865f2)
    .setTimestamp();

  for (const [key, value] of Object.entries(healthData)) {
    embed.addFields({ name: key, value: truncate(value), inline: false });
  }

  return embed;
}

function buildSuccessEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("✅ Success")
    .setDescription(message)
    .setColor(0x57f287)
    .setTimestamp();
}

function buildErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("❌ Error")
    .setDescription(message)
    .setColor(0xed4245)
    .setTimestamp();
}

// ---------------------------------------------------------------------------
// Interaction handler
// ---------------------------------------------------------------------------

export async function handleMultiAuthCommand(
  interaction: ChatInputCommandInteraction,
  accountManager: AccountManager,
): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;

  if (cmd === "multi-auth") {
    return handleMultiAuthStatus(interaction, accountManager);
  }
  if (cmd === "multi-auth-add-apikey") {
    return handleAddApikey(interaction, accountManager);
  }
  if (cmd === "multi-auth-delete") {
    return handleDelete(interaction, accountManager);
  }
  if (cmd === "multi-auth-switch") {
    return handleSwitch(interaction, accountManager);
  }
  if (cmd === "multi-auth-auto") {
    return handleAuto(interaction, accountManager);
  }
  if (cmd === "multi-auth-rename") {
    return handleRename(interaction, accountManager);
  }
  if (cmd === "multi-auth-rotation") {
    return handleRotation(interaction, accountManager);
  }
  if (cmd === "multi-auth-hide") {
    return handleHide(interaction, accountManager);
  }
}

async function handleMultiAuthStatus(
  interaction: ChatInputCommandInteraction,
  accountManager: AccountManager,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "status") {
      const statuses = await getProviderStatuses(accountManager);
      const embed = buildStatusEmbed(statuses);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (subcommand === "usage") {
      const usageMap = await getUsageOverview(accountManager);
      const embed = buildUsageEmbed(usageMap);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (subcommand === "health") {
      const healthData = await getHealthOverview(accountManager);
      const embed = buildHealthEmbed(healthData);
      await interaction.editReply({ embeds: [embed] });
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({ embeds: [buildErrorEmbed(message)] });
  }
}

async function handleAddApikey(
  interaction: ChatInputCommandInteraction,
  accountManager: AccountManager,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const provider = interaction.options.getString("provider", true) as SupportedProviderId;
    const key = interaction.options.getString("key", true);

    const result = await accountManager.addApiKeyCredential(provider, key);

    const name = interaction.options.getString("name")?.trim();
    if (name) {
      await accountManager.setFriendlyName(provider, result.credentialId, name);
    }

    await interaction.editReply({
      embeds: [
        buildSuccessEmbed(
          `Added credential \`${result.credentialId}\` for **${provider}**.\n` +
            `${result.isBackupCredential ? "Added as backup." : "Added as primary."}\n` +
            `Total credentials: ${result.credentialIds.length}`,
        ),
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({ embeds: [buildErrorEmbed(message)] });
  }
}

async function handleDelete(
  interaction: ChatInputCommandInteraction,
  accountManager: AccountManager,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const provider = interaction.options.getString("provider", true) as SupportedProviderId;
    const credential = interaction.options.getString("credential", true);

    await accountManager.deleteCredential(provider, credential);
    await interaction.editReply({
      embeds: [buildSuccessEmbed(`Deleted credential \`${credential}\` for **${provider}**.`)],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({ embeds: [buildErrorEmbed(message)] });
  }
}

async function handleSwitch(
  interaction: ChatInputCommandInteraction,
  accountManager: AccountManager,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const provider = interaction.options.getString("provider", true) as SupportedProviderId;
    const index = interaction.options.getInteger("index", true);

    await accountManager.switchActiveCredential(provider, index);
    const state = await accountManager.getProviderStatus(provider);
    const cred = state.credentials[index];

    await interaction.editReply({
      embeds: [
        buildSuccessEmbed(
          `Switched **${provider}** to credential \`${cred.credentialId}\` (index ${index}).` +
            (cred.friendlyName ? ` — "${cred.friendlyName}"` : ""),
        ),
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({ embeds: [buildErrorEmbed(message)] });
  }
}

async function handleAuto(
  interaction: ChatInputCommandInteraction,
  accountManager: AccountManager,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const provider = interaction.options.getString("provider", true) as SupportedProviderId;
    await accountManager.clearManualActiveCredential(provider);
    await interaction.editReply({
      embeds: [buildSuccessEmbed(`**${provider}** returned to automatic rotation.`)],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({ embeds: [buildErrorEmbed(message)] });
  }
}

async function handleRename(
  interaction: ChatInputCommandInteraction,
  accountManager: AccountManager,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const provider = interaction.options.getString("provider", true) as SupportedProviderId;
    const credential = interaction.options.getString("credential", true);
    const name = interaction.options.getString("name", true);

    const resolved = await accountManager.setFriendlyName(provider, credential, name);
    await interaction.editReply({
      embeds: [
        buildSuccessEmbed(
          `Renamed \`${credential}\` to **"${resolved}"** for **${provider}**.`,
        ),
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({ embeds: [buildErrorEmbed(message)] });
  }
}

async function handleRotation(
  interaction: ChatInputCommandInteraction,
  accountManager: AccountManager,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const provider = interaction.options.getString("provider", true) as SupportedProviderId;
    const mode = interaction.options.getString("mode", true) as "round-robin" | "usage-based" | "balancer";

    await accountManager.setRotationMode(provider, mode);

    await interaction.editReply({
      embeds: [
        buildSuccessEmbed(
          `Set **${provider}** rotation mode to "${mode}".`,
        ),
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({ embeds: [buildErrorEmbed(message)] });
  }
}

async function handleHide(
  interaction: ChatInputCommandInteraction,
  accountManager: AccountManager,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const provider = interaction.options.getString("provider", true) as SupportedProviderId;
    const hidden = interaction.options.getBoolean("hidden") ?? true;

    const result = await accountManager.setProviderHidden(provider, hidden);
    await interaction.editReply({
      embeds: [
        buildSuccessEmbed(
          result
            ? `Provider **${provider}** is now hidden.`
            : `Provider **${provider}** is now visible.`,
        ),
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({ embeds: [buildErrorEmbed(message)] });
  }
}

// ---------------------------------------------------------------------------
// Status aggregation helpers
// ---------------------------------------------------------------------------

async function getProviderStatuses(
  accountManager: AccountManager,
): Promise<ProviderStatus[]> {
  const providers = await accountManager.getSupportedProviders();
  const statuses: ProviderStatus[] = [];

  for (const provider of providers) {
    try {
      const status = await accountManager.getProviderStatus(provider);
      statuses.push(status);
    } catch {
      // Skip providers that can't be queried
    }
  }

  return statuses;
}

async function getUsageOverview(
  accountManager: AccountManager,
): Promise<Record<string, string>> {
  const providers = await accountManager.getSupportedProviders();
  const usageMap: Record<string, string> = {};

  for (const provider of providers) {
    try {
      const status = await accountManager.getProviderStatus(provider);
      for (const cred of status.credentials) {
        const snapshot = cred.usageSnapshot;
        if (!snapshot) continue;

        const lines: string[] = [];

        if (snapshot.primary) {
          lines.push(`Primary: ${snapshot.primary.usedPercent.toFixed(1)}% used`);
          if (snapshot.primary.resetsAt) {
            lines.push(`  Resets: ${new Date(snapshot.primary.resetsAt * 1000).toLocaleString()}`);
          }
        }
        if (snapshot.secondary) {
          lines.push(`Secondary: ${snapshot.secondary.usedPercent.toFixed(1)}% used`);
        }
        if (snapshot.copilotQuota) {
          if (snapshot.copilotQuota.chat) {
            lines.push(
              `Copilot Chat: ${snapshot.copilotQuota.chat.remaining ?? "∞"} remaining` +
                (snapshot.copilotQuota.chat.unlimited ? " (unlimited)" : ""),
            );
          }
          if (snapshot.copilotQuota.completions) {
            lines.push(
              `Copilot Completions: ${snapshot.copilotQuota.completions.remaining ?? "∞"} remaining`,
            );
          }
        }

        if (lines.length > 0) {
          usageMap[`${provider} / ${cred.friendlyName ?? cred.credentialId}`] = lines.join("\n");
        }
      }
    } catch {
      usageMap[provider] = "Unable to fetch usage data.";
    }
  }

  return usageMap;
}

async function getHealthOverview(
  accountManager: AccountManager,
): Promise<Record<string, string>> {
  const healthData: Record<string, string> = {};
  // Health data is exposed through the AccountManager's health scorer.
  // For now we provide an overview.
  const providers = await accountManager.getSupportedProviders();

  for (const provider of providers) {
    try {
      const status = await accountManager.getProviderStatus(provider);
      for (const cred of status.credentials) {
        if (cred.usageCount > 0 || cred.quotaErrorCount > 0) {
          const healthLine = [
            `Usage: ${cred.usageCount}`,
            `Quota errors: ${cred.quotaErrorCount}`,
            cred.transientErrorCount ? `Transient: ${cred.transientErrorCount}` : null,
          ]
            .filter(Boolean)
            .join(" | ");
          healthData[`${provider} / ${cred.friendlyName ?? cred.credentialId}`] = truncate(healthLine);
        }
      }
    } catch {
      healthData[provider] = "Unable to fetch health data.";
    }
  }

  if (Object.keys(healthData).length === 0) {
    healthData["_"] = "No credential data yet. Health metrics will appear after requests are made.";
  }

  return healthData;
}
