import { SlashCommandBuilder, type RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import type { SkillSummary } from "../types.js";

const RESERVED_COMMAND_NAMES = new Set([
  "ask",
  "abort",
  "reset",
  "resume",
  "sessions",
  "status",
  "models",
  "scope-models",
  "use-model",
  "reload",
  "project-create",
  "add-project",
  "project-list",
  "diff",
  "review",
  "access-requests",
  "access-allow",
  "access-deny",
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

function buildUseModelCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("use-model")
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

function buildReloadCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("reload")
    .setDescription("Reload picord runtime")
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
    .setDescription("Map an existing local project path to a Discord project channel")
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

function buildProjectListCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("project-list")
    .setDescription("List managed project channels")
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

function buildAccessAllowCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("access-allow")
    .setDescription("Approve a pending access request")
    .addStringOption((option) =>
      option
        .setName("request_id")
        .setDescription("Pending access request ID")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Approve once or permanently")
        .addChoices(
          { name: "once", value: "once" },
          { name: "always", value: "always" },
        )
        .setRequired(true),
    )
    .toJSON();
}

function buildAccessDenyCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("access-deny")
    .setDescription("Deny a pending access request")
    .addStringOption((option) =>
      option
        .setName("request_id")
        .setDescription("Pending access request ID")
        .setRequired(true),
    )
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
    buildReloadCommand(),
    buildProjectCreateCommand(),
    buildAddProjectCommand(),
    buildResumeCommand(),
    buildSessionsCommand(),
    buildAbortCommand(),
    buildResetCommand(),
    buildProjectListCommand(),
    buildDiffCommand(),
    buildReviewCommand(),
    buildAccessRequestsCommand(),
    buildAccessAllowCommand(),
    buildAccessDenyCommand(),
    buildStatusCommand(),
    ...skills.map(buildSkillCommand).filter((command): command is RESTPostAPIChatInputApplicationCommandsJSONBody => Boolean(command)),
  ];
}
