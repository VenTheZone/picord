# Picord Agent Installation Guide

This guide is written for a **coding agent** (pi) that is setting up picord on
behalf of a user. Work through the steps in order. Every step that says
"ask the user" means: stop, request that input in a clear message, and wait
for the answer before continuing.

**Agent rules**

- Never invent Discord credentials, IDs, or tokens. If a value is missing, ask.
- Never put the bot token in `picord.config.json` or any committed file. It is an environment variable only.
- Do not commit `picord.config.json` or `picord.state.json`; both are gitignored.
- If a step fails, tell the user what failed and what you tried before moving on.

---

## 0. What you need from the user

Before installing, collect these from the user. This is the only part you
cannot do yourself:

| Value | Where the user gets it | Required |
|---|---|---|
| Discord bot token | Discord Developer Portal → your app → Bot → **Reset Token** | yes |
| Owner Discord user ID | Discord client → Settings → Advanced → enable **Developer Mode**, then right-click the user → **Copy User ID** | yes |
| Guild (server) ID | Right-click the server → **Copy Server ID** | yes |
| Host channel name | A text channel for admin commands (default: `host`) | no (defaults apply) |

Application ID is **optional** — picord reads it from the bot client at
runtime. If the user has it handy, use it for reference, but never block
installation on it.

If the user does not yet have a Discord application, guide them through
Section 2 first, then collect the values.

---

## 1. Check prerequisites

Run these checks and report the result to the user:

```bash
node -v     # need 20.6 or newer
pi --version
```

If pi is missing, tell the user and point them to pi's quickstart
(https://github.com/earendil-works/pi-coding-agent) — do not install it
yourself without asking.

---

## 2. Guide the user through the Discord app setup

The user needs a Discord application with a bot. Give them this checklist:

1. Go to https://discord.com/developers/applications → **New Application**.
2. **Bot** page → **Reset Token** and copy it. Keep it secret.
3. **Bot** page → Privileged Gateway Intents → enable **Message Content Intent**.
   (Without it the bot only works via slash commands.)
4. **OAuth2 → URL Generator** → select the bot, then scopes `bot` and
   `applications.commands`.
5. With the `bot` scope selected, choose permissions:
   `View Channels`, `Send Messages`, `Send Messages in Threads`,
   `Create Public Threads`, `Manage Threads`, `Read Message History`,
   `Use Application Commands`, `Manage Channels`.
6. Copy the generated URL, open it, and invite the bot to the guild.

Then collect the values from Section 0 and confirm each one with the user
before proceeding.

---

## 3. Install picord into pi

```bash
pi install npm:@venthezone/picord
pi list   # confirm picord appears in the installed packages
```

If the user is developing picord itself, install from the local checkout
instead:

```bash
cd /path/to/picord
pi install ./picord
```

---

## 4. Create the config file

The bot reads `picord.config.json` from pi's working directory (cwd), or from
the path in the `PICORD_CONFIG` environment variable.

Create the config in the user's project directory (not inside the picord
package). Use the values the user provided:

```json
{
  "ownerUserId": "USER_ID_FROM_STEP_0",
  "allowedGuildIds": ["GUILD_ID_FROM_STEP_0"],
  "hostChannelName": "host",
  "registerCommands": true
}
```

Optional but useful for real use:

- `allowDm` — allow the bot in DMs (default `true`)
- `allowedRoleNames` — e.g. `["picord"]`, restrict usage to users with a role
- `allowedChannelIds` — restrict to specific channels
- `workspaceBasePath` — where `/project-create` makes workspaces (default `~/.picord/workspace`)

If the config lives somewhere other than the pi cwd, set:

```bash
export PICORD_CONFIG=/absolute/path/to/picord.config.json
```

Full field reference: `picord.config.example.json` in the package.

---

## 5. Set the Discord token

The token is an environment variable — never put it in the JSON config.

```bash
export PICORD_DISCORD_TOKEN="token_from_step_2"
```

`DISCORD_BOT_TOKEN` also works as a fallback. Tell the user where this
environment variable should live permanently (`.env`, shell profile, or their
process manager) and make sure it is not committed to git.

Optional: `PICORD_ENCRYPTION_KEY` encrypts stored credentials at rest.

---

## 6. Start and verify

picord is a pi extension: it starts the Discord bot when a pi session starts.

1. Run pi in the directory that contains `picord.config.json`:
   ```bash
   pi
   ```
2. Expect a notify message: `discord-port: connected` (or a warning explaining
   why it stayed inactive — usually the token).
3. In Discord, check the bot shows **online** in the guild, then test:
   - In the host channel (default `host`), run `/status` — should reply.
   - Create a project channel with `/project-create name=test`, start a
     thread in it, and `/ask hello` — should reply in the thread.

Slash commands register automatically on startup (`registerCommands` defaults
to `true`), so no manual sync is needed.

---

## 7. Troubleshooting the agent can do on its own

| Symptom | Check |
|---|---|
| Bot stays offline | `PICORD_DISCORD_TOKEN` set? Bot token reset after invite? Invite re-run with new token. |
| Bot online but silent | Message Content Intent enabled? Bot in `allowedGuildIds`? Host channel exists? |
| `/status` no reply | `ownerUserId` matches the user? Running in host channel? `registerCommands` true and bot re-invited after intent change? |
| "Access denied" | Add the user to `allowedUserIds`/`allowedRoleNames`, or the agent approves via `/access-allow` as owner. |
| Commands missing after code changes | Re-run `pi update npm:@venthezone/picord` and restart pi. |

For anything else, report the exact error text to the user and ask.

---

## Uninstall

```bash
pi remove npm:@venthezone/picord
```

Delete `picord.state.json` to clear stored credentials (optional).
