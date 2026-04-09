import { SlashCommandBuilder, type RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import type { SkillSummary } from "../types.js";

const RESERVED_COMMAND_NAMES = new Set([
  "ask",
  "abort",
  "reset",
  "refresh-session",
  "resume",
  "session",
  "sessions",
  "status",
  "model",
  "models",
  "scope-models",
  "use-model",
  "think",
  "think-visibility",
  "login",
  "reload",
  "restart",
  "project-create",
  "add-project",
  "add-project-path",
  "project-list",
  "project-list-available",
  "diff",
  "review",
  "access-requests",
  "outside-workspace-access",
]);

function truncateDescription(description: string): string {
  return description.length <= 100 ? description : `${description.slice(0, 97)}...`;
}

function buildSkillCommand(skill: SkillSummary): RESTPostAPIChatInputApplicationCommandsJSONBody | undefined {
  if (RESERVED_COMMAND_NAMES.has(skill.name)) return undefined;
  if (!/^[a-z0-9-]{1,32}$/.test(skill.name)) return undefined;

  return new SlashCommandBuilder()
    .setName(skill.name)
    .setDescription(truncateDescription(skill.description || `Run the ${skill.name} skill`))
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Optional arguments or prompt text for the skill")
        .setRequired(false),
    )
    .toJSON();
}

function buildAskCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask pi in the current Discord session")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Prompt to send to pi")
        .setRequired(true),
    )
    .toJSON();
}

function buildScopeModelsCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("scope-models")
    .setDescription("Choose the workspace model scope for one provider")
    .addStringOption((option) =>
      option
        .setName("provider")
        .setDescription("Provider to browse models from")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("Optional filter for long provider model lists")
        .setRequired(false),
    )
    .toJSON();
}

function buildUseModelCommand(commandName: "use-model" | "model" = "use-model"): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName(commandName)
    .setDescription("Set the active workspace model")
    .addStringOption((option) =>
      option
        .setName("model")
        .setDescription("Model reference in provider/model-id form")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .toJSON();
}

function buildThinkCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("think")
    .setDescription("Set the active thinking level")
    .addStringOption((option) =>
      option
        .setName("level")
        .setDescription("Thinking level")
        .addChoices(
          { name: "none", value: "off" },
          { name: "low", value: "low" },
          { name: "medium", value: "medium" },
          { name: "high", value: "high" },
          { name: "xhigh", value: "xhigh" },
        )
        .setRequired(true),
    )
    .toJSON();
}

function buildThinkingVisibilityCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("think-visibility")
    .setDescription("Toggle whether to show thinking process in the chat")
    .toJSON();
}

export function buildLoginCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("login")
    .setDescription("Add or update API keys and OAuth credentials for providers")
    .addStringOption((option) =>
      option
        .setName("provider")
        .setDescription("Provider to configure")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option
        .setName("key")
        .setDescription("API key to save (auto-saved)")
        .setRequired(false),
    )
    .toJSON();
}

function buildReloadCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("reload")
    .setDescription("Restart the current session so new config and tools apply on the next message")
    .toJSON();
}

function buildRestartCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart the tmux-managed picord runtime and notify this channel when it returns")
    .toJSON();
}

function buildProjectCreateCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("project-create")
    .setDescription("Create a new project channel backed by a workspace directory")
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Project name")
        .setRequired(true),
    )
    .toJSON();
}

function buildAddProjectCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("add-project")
    .setDescription("Pick an existing project and create or reuse its Discord project channel")
    .toJSON();
}

function buildAddProjectPathCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("add-project-path")
    .setDescription("Advanced: map an existing local project path to a Discord project channel")
    .addStringOption((option) =>
      option
        .setName("path")
        .setDescription("Existing local directory path")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Create a new project channel or bind the current channel")
        .addChoices(
          { name: "new-channel", value: "new-channel" },
          { name: "current-channel", value: "current-channel" },
        )
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Optional project/channel name")
        .setRequired(false),
    )
    .toJSON();
}

function buildResumeCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Bind this thread to an existing pi session")
    .addStringOption((option) =>
      option
        .setName("session")
        .setDescription("Existing pi session file path or session ID")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .toJSON();
}

function buildSessionsCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("sessions")
    .setDescription("List resumable pi sessions for the current workspace")
    .toJSON();
}

function buildSessionCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("session")
    .setDescription("Pick an existing pi session and create or reuse its project channel")
    .toJSON();
}

function buildAbortCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("abort")
    .setDescription("Abort the active pi run in the current thread")
    .toJSON();
}

function buildResetCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Clear the current thread's bound pi session")
    .toJSON();
}

function buildRefreshSessionCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("refresh-session")
    .setDescription("Reset this thread session so you can start clean")
    .toJSON();
}

function buildProjectListCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("project-list")
    .setDescription("List managed project channels")
    .toJSON();
}

function buildProjectListAvailableCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("project-list-available")
    .setDescription("List direct subfolders under the configured workspace base path")
    .toJSON();
}

function buildDiffCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("diff")
    .setDescription("Upload the current git diff to critique.work")
    .toJSON();
}

function buildReviewCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("review")
    .setDescription("Generate a critique.work review for the current git diff")
    .toJSON();
}

function buildAccessRequestsCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("access-requests")
    .setDescription("List pending access requests")
    .toJSON();
}

function buildOutsideWorkspaceAccessCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("outside-workspace-access")
    .setDescription("Allow or deny AI access outside the current project workspace")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Allow or deny access outside the current project workspace")
        .addChoices(
          { name: "allow", value: "allow" },
          { name: "deny", value: "deny" },
        )
        .setRequired(true),
    )
    .toJSON();
}

function buildCompactCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Manually compact the current session context")
    .toJSON();
}

function buildAutoCompactCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("auto-compact")
    .setDescription("Toggle automatic context compaction")
    .toJSON();
}

function buildStatusCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show discord-port runtime status for this location")
    .toJSON();
}

export function buildDiscordPortCommands(skills: SkillSummary[] = []): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [
    buildAskCommand(),
    buildScopeModelsCommand(),
    buildUseModelCommand(),
    buildUseModelCommand("model"),
    buildThinkCommand(),
    buildThinkingVisibilityCommand(),
    buildLoginCommand(),
    buildReloadCommand(),
    buildRestartCommand(),
    buildProjectCreateCommand(),
    buildAddProjectCommand(),
    buildAddProjectPathCommand(),
    buildResumeCommand(),
    buildSessionCommand(),
    buildSessionsCommand(),
    buildAbortCommand(),
    buildResetCommand(),
    buildRefreshSessionCommand(),
    buildProjectListCommand(),
    buildProjectListAvailableCommand(),
    buildDiffCommand(),
    buildReviewCommand(),
    buildAccessRequestsCommand(),
    buildOutsideWorkspaceAccessCommand(),
    buildStatusCommand(),
    buildCompactCommand(),
    buildAutoCompactCommand(),
    ...skills.map(buildSkillCommand).filter((command): command is RESTPostAPIChatInputApplicationCommandsJSONBody => Boolean(command)),
  ];
}
