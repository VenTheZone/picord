# picord

`picord` is a Discord integration extension for pi / pi-mono.

npm package: `@venthezone/picord`

It lets you run pi from Discord while keeping pi’s native sessions, models, skills, and extensions.

## Mental model

In a guild:
- a **project channel** maps to a local workspace
- a **thread** inside that channel maps to a pi session
- the **thread title** becomes the session name

In DMs:
- the DM acts like a direct personal session

## Runtime

- Default runtime: `discord-port`
- Legacy fallback: `PICORD_RUNTIME_ARCH=legacy`

`discord-port` is the main runtime now.

## What picord gives you

- Discord bot integration as a pi extension
- project channel → workspace mapping
- thread → pi session binding
- pi skills exposed as slash commands
- model and thinking controls from Discord
- provider login and API key update flow from Discord
- native pi session resume support
- workspace-only file access by default
- approval flow for blocked or out-of-workspace access
- managed project channels backed by local workspace folders

## Quick start

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

For a stable VPS/runtime setup, run picord in its own tmux session from the local repo source.

Start it:

```bash
cd /path/to/picord
set -a && source .env && set +a
npm run sync:discord-commands

tmux new-session -d -s picord 'cd /path/to/picord && set -a && source .env && set +a && exec pi -e ./src/index.ts --no-session'
```

Useful tmux commands:

```bash
# attach to the running session
tmux attach -t picord

# stop picord
tmux kill-session -t picord

# restart picord after code changes
tmux kill-session -t picord 2>/dev/null || true
npm run build
npm run sync:discord-commands
tmux new-session -d -s picord 'cd /path/to/picord && set -a && source .env && set +a && exec pi -e ./src/index.ts --no-session'
```

This is the recommended way to keep picord running on a remote machine while still using the live local source tree.

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
- `workspaceRoots`: optional static mapping of project channel ID → local workspace path; leave it empty if you want `/project-create` to manage channels and workspace folders for you
- `allowedChannelIds`: static channel allowlist; bot-managed project channels are added from state
- `allowedRoleIds` / `allowedRoleNames`: required guild roles for normal bot usage
- `allowedUserIds`: explicit user allowlist
- `ownerUserId`: owner who can approve access requests and run owner-only commands
- `hostChannelId`: exact control channel ID for owner/admin commands
- `hostChannelName`: fallback control channel name; defaults to `host`
- `blockedPathPatterns`: sensitive files that stay blocked or approval-gated
- `critiqueAutoShare`: when true, picord appends a critique.work diff link after Discord runs that change the git working tree

## How to use it

### In guilds

1. create or map a project channel to a workspace
2. send a message in that project channel to start a thread
3. keep working inside the thread
4. that thread stays bound to the same pi session

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

`/session` works in the host channel and lets you pick an existing pi session. Picord will create or reuse the matching project channel for that session's workspace, create a thread, and resume the selected session there.

### In DMs

DMs work as a direct session using the configured default workspace.

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

These must be run in the configured host control channel.

- `/reload`
- `/login`
- `/project-create name:<project-name>`
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

If you are running picord from the local source tree in tmux on a VPS, the usual update cycle is:

```bash
cd /path/to/picord
npm run build
npm run sync:discord-commands

tmux kill-session -t picord 2>/dev/null || true
tmux new-session -d -s picord 'cd /path/to/picord && set -a && source .env && set +a && exec pi -e ./src/index.ts --no-session'
```

## Current limitations

- Full guild message flow depends on **Message Content Intent** being enabled on the Discord app
- DMs and unmapped channels still fall back to the configured default `cwd`
- OpenAI Codex login in picord currently uses a Discord-guided manual completion flow rather than a native one-time device-code screen
- Bash safety is path-based and conservative; direct tool access is guarded more strictly than arbitrary shell behavior
