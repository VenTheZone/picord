# picord

`picord` is a Discord integration for pi / pi-mono.

npm package: `@venthezone/picord`

It lets you use pi from Discord while keeping pi’s native sessions, models, skills, and extensions.

## Mental model

In a guild:
- a **project channel** maps to a local workspace
- a **thread** inside that channel maps to a pi session
- the **thread title** becomes the session name

In DMs:
- the DM acts like a direct personal session

If you remember one thing, remember this:
**channel = workspace, thread = session**.

## Runtime

- Default runtime: `discord-port`
- Legacy fallback: `PICORD_RUNTIME_ARCH=legacy`

`discord-port` is the main runtime and the one you should use unless you have a specific reason not to.

## What picord gives you

- a Discord bot that runs pi as an extension
- project channel → workspace mapping
- thread → pi session binding
- pi skills exposed as slash commands
- model and thinking controls from Discord
- provider login and API key update flows from Discord
- native pi session resume support
- workspace-only file access by default
- approval flow for blocked or out-of-workspace access
- managed project channels backed by local workspace folders

## Quick start

For a detailed, step‑by‑step installation guide you can run alongside your pi agent, see [INSTALL.md](INSTALL.md).

### 1. Install dependencies

```bash
cd picord
npm install
```

### 2. Set your Discord token

See `.env.example`.

```bash
export PICORD_DISCORD_TOKEN=your_discord_bot_token
```

`DISCORD_BOT_TOKEN` also works as a fallback.

### 3. Create a local config file

```bash
cp picord.config.example.json picord.config.json
```

`picord.config.json` is local-only and gitignored.

### 4. Set up the Discord app

#### OAuth2 scopes

Use these scopes:
- `bot`
- `applications.commands`

#### Bot permissions

Recommended permissions:
- `View Channels`
- `Send Messages`
- `Send Messages in Threads`
- `Create Public Threads`
- `Manage Threads`
- `Read Message History`
- `Use Application Commands`
- `Manage Channels`
- `Manage Roles` *(optional, only needed if you want picord to auto-create the configured access role)*

#### Bot page

In the Discord Developer Portal:
- open your application
- go to **Bot**
- enable **Message Content Intent**

That intent is required for the full message-driven guild flow.

### 5. Install picord as a pi extension

For normal use, install picord as a persistent pi extension.

The published package name is:

```bash
@venthezone/picord
```

You can install it through pi with:

```bash
pi install npm:@venthezone/picord
```

You can also use the local repo directly by either:
- adding this package path to your pi extension settings, or
- symlinking or copying the repo into `~/.pi/agent/extensions/picord/`

This repo already declares its extension entrypoint in `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

### 6. Run a one-off local test

If you just want to try picord without installing it persistently, run:

```bash
pi -e ./src/index.ts --no-session
```

### 7. Run picord in tmux

For a stable VPS or remote setup, run picord in its own tmux session from the local repo source.

Recommended workflow:

```bash
cd /path/to/picord
npm run picord:start
```

Useful runtime commands:

```bash
# show tmux + systemd state
npm run picord:status

# show recent tmux output
npm run picord:logs

# restart after code changes
npm run picord:restart

# stop picord
npm run picord:stop
```

The wrapper script keeps startup predictable by:
- requiring `.env`
- running `npm run sync:discord-commands`
- stopping the `picord` systemd service first if it is active
- recreating the tmux session cleanly

If you want to inspect the live tmux session directly:

```bash
tmux attach -t picord
```

This is the recommended way to keep picord running on a remote machine while still using the live source tree.

### 8. Verify the setup

```bash
npm run check
npm run doctor
npm run smoke:discord
```

If slash commands drift after adding commands or skills, run:

```bash
npm run sync:discord-commands
```

## Configuration

### Required environment

```bash
export PICORD_DISCORD_TOKEN=your_discord_bot_token
```

### Optional environment

```bash
export PICORD_DISCORD_APPLICATION_ID=your_application_id
export PICORD_CONFIG=/absolute/or/relative/path/to/picord.config.json
export PICORD_RUNTIME_ARCH=legacy
export PICORD_EXA_API_KEY=your_exa_api_key
```

### Example config

```json
{
  "allowDm": true,
  "cwd": ".",
  "statePath": "./picord.state.json",
  "workspaceBasePath": "~/.picord/workspace",
  "workspaceRoots": {},
  "toolMode": "coding",
  "allowedGuildIds": ["123"],
  "allowedChannelIds": [],
  "allowedRoleIds": [],
  "allowedRoleNames": ["picord"],
  "allowedUserIds": [],
  "ownerUserId": "222",
  "blockedPathPatterns": [".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_ed25519"],
  "hostChannelId": "123456789012345678",
  "hostChannelName": "host",
  "registerCommands": true,
  "thinkingLevel": "off",
  "critiqueAutoShare": false,
  "systemPromptAppend": "Prefer concise Discord-friendly replies."
}
```

### Important fields

- `cwd`: default workspace root for DMs or unmapped channels
- `statePath`: persistent state for managed project channels and thread/session bindings
- `workspaceBasePath`: base directory used by `/project-create`; defaults to `~/.picord/workspace`
- `workspaceRoots`: optional static mapping of project channel ID → local workspace path; leave it empty if you want `/project-create` to manage channels and workspace folders
- `allowedChannelIds`: static channel allowlist; bot-managed project channels are added from state
- `allowedRoleIds` / `allowedRoleNames`: required guild roles for normal bot usage
- `allowedUserIds`: explicit user allowlist
- `ownerUserId`: owner who can approve access requests and run owner-only commands
- `hostChannelId`: exact control channel ID for owner/admin commands
- `hostChannelName`: fallback control channel name; defaults to `host`
- `blockedPathPatterns`: sensitive files that stay blocked or approval-gated
- `critiqueAutoShare`: when true, picord appends a critique.work diff link after Discord runs that change the git working tree
- `exaApiKey`: Optional Exa API key to skip OAuth flow; Exa works without it via MCP OAuth

## Built-in MCP servers

Picord includes built-in MCP servers that are automatically enabled. These load in addition to any servers configured in `~/.pi/mcp.json`.

### Exa (web search)

[Exa](https://exa.ai) provides AI-powered web search, code search, and company research tools. Exa is **always enabled** — no API key required. On first use, Exa's hosted MCP server initiates an OAuth flow so you can authenticate in-browser for free access.

**Configuration (optional):**

If you have an Exa API key and want to skip the OAuth flow, set it via environment variable:
```bash
export PICORD_EXA_API_KEY=your_exa_api_key
```

Or in `picord.config.json`:
```json
{
  "exaApiKey": "your_exa_api_key"
}
```

Get your API key at [dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys).

Requires `@modelcontextprotocol/sdk` with streamable HTTP transport support (v1.9.0+). If the SDK version doesn't support streamable HTTP, the Exa server is silently skipped.

## How to use it

### In guilds

1. create or map a project channel to a workspace
2. send a message in that project channel to start a thread
3. keep working inside the thread
4. that thread stays bound to the same pi session

That is the main flow for normal project use.

Use the host control channel for owner and admin actions like:
- `/project-create`
- `/add-project`
- `/add-project-path`
- `/project-list`
- `/project-list-available`
- `/session`
- `/login`
- `/reload`
- `/access-requests`
- `/access-allow`
- `/access-deny`

`/add-project` opens a picker for direct subfolders under `workspaceBasePath` and creates or reuses a project channel automatically.

For advanced manual binding, use `/add-project-path`. In `current-channel` mode, run it as the owner in the channel you want to bind.

`/session` works in the host channel and lets you pick an existing pi session. Picord will create or reuse the matching project channel for that session workspace, create a thread, and resume the selected session there.

### In DMs

DMs work as a direct session using the configured default workspace.
This is useful for quick personal tasks when you do not need a guild project channel.

## Commands

### Session and workspace

- `/ask prompt:<text>`
- `/abort`
- `/refresh-session`
- `/resume session:<session-file-or-id>`
- `/sessions`
- `/reset`
- `/status`
- `/scope-models provider:<provider> query:<optional filter>`
- `/use-model model:<provider/model>`
- `/model model:<provider/model>`
- `/think level:<none|low|medium|high|xhigh>`
- `/diff`
- `/review`

`/diff` uploads the current git diff to critique.work and returns the shareable URL.
`/review` asks critique to generate a review for the current diff and returns the review URL.

### Owner and admin

These commands must be run in the configured host control channel.

- `/reload`
- `/login`
- `/project-create name:<project-name>`

`/login` opens a provider picker. API-key providers prompt for a replacement key in Discord. `openai-codex` prefers the headless device flow: picord shows the OpenAI verification URL plus the one-time code and then polls for completion automatically.
- `/add-project`
- `/add-project-path path:<path> mode:<new-channel|current-channel> name:<optional>`
- `/project-list`
- `/project-list-available`
- `/session`
- `/access-requests`
- `/access-allow request_id:<id> mode:once|always`
- `/access-deny request_id:<id>`

### Skills

Each discovered pi skill with a Discord-safe name is also registered as a slash command.

Examples from this environment include:
- `/brainstorming`
- `/humanizer`
- `/security-review`
- `/tdd-workflow`
- `/verification-loop`

Each skill command accepts an optional `prompt` argument and runs through pi as `/skill:<name>`.

## Security model

- Discord token is read from environment variables, not from JSON config
- guild access is restricted by allowlists and role checks
- file access is limited to the workspace root by default
- sensitive paths like `.env`, `.env.*`, `*.pem`, and `*.key` are blocked or approval-gated
- blocked or out-of-workspace access requests are sent back to Discord for owner approval

## Maintenance

Useful commands:

```bash
npm run check
npm run doctor
npm run doctor:discord-port
npm run doctor:legacy
npm run smoke:discord
npm run smoke:discord:port
npm run smoke:discord:legacy
npm run sync:discord-commands
```

If you are running picord from the local source tree in tmux on a VPS, use the runtime wrapper script for a consistent setup:

```bash
cd /path/to/picord
npm run picord:start
npm run picord:status
npm run picord:logs
npm run picord:restart
npm run picord:stop
```

The wrapper script:
- requires `.env`
- runs `npm run sync:discord-commands` on start
- stops the `picord` systemd service if it is active so you do not run duplicate bot processes
- recreates the tmux session cleanly

## Current limitations

- Full guild message flow depends on **Message Content Intent** being enabled on the Discord app
- DMs and unmapped channels still fall back to the configured default `cwd`
- OpenAI Codex login prefers the native headless device flow and polls automatically after you enter the one-time code on OpenAI's verification page; the manual paste flow remains only as a fallback if OpenAI falls back to browser completion
- Bash safety is path-based and conservative; direct tool access is guarded more strictly than arbitrary shell behavior
