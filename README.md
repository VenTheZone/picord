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
- model controls from Discord
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

### 7. Verify the setup

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

## How to use it

### In guilds

1. create or map a project channel to a workspace
2. send a message in that project channel to start a thread
3. keep working inside the thread
4. that thread stays bound to the same pi session

Use the host control channel for owner and admin actions like:
- `/project-create`
- `/project-list`
- `/reload`
- `/access-requests`
- `/access-allow`
- `/access-deny`

### In DMs

DMs work as a direct session using the configured default workspace.

## Commands

### Session and workspace

- `/ask prompt:<text>`
- `/abort`
- `/resume session:<session-file-or-id>`
- `/sessions`
- `/reset`
- `/status`
- `/scope-models provider:<provider> query:<optional filter>`
- `/use-model model:<provider/model>`

### Owner and admin

These must be run in the configured host control channel.

- `/reload`
- `/project-create name:<project-name>`
- `/project-list`
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

## Current limitations

- Full guild message flow depends on **Message Content Intent** being enabled on the Discord app
- DMs and unmapped channels still fall back to the configured default `cwd`
- Bash safety is path-based and conservative; direct tool access is guarded more strictly than arbitrary shell behavior
