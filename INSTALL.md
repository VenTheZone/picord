# Picord Installation Guide

This guide helps you install and configure picord from source, working alongside your pi agent.

[!NOTE]
If you already have **pi** installed and running, you can install picord directly from your pi agent by running:

```bash
pi install npm:@venthezone/picord
```

Then configure it as described below.

## Prerequisites

- Node.js 20.6 or newer
- Git
- Access to a Discord application (bot token + Application ID)
- pi installed and working

---

## Step 1: Clone Repository

Choose a location for your picord workspace, then:

```bash
git clone https://github.com/VenTheZone/picord.git
cd picord
```

---

## Step 2: Install Dependencies

```bash
npm ci
```

---

## Step 3: Create Configuration

Create `picord.config.json` in this repository root (or in a separate config directory; see below). Minimal example:

```json
{
  "discordToken": "YOUR_BOT_TOKEN",
  "discordApplicationId": "YOUR_APPLICATION_ID",
  "ownerUserId": "YOUR_DISCORD_USER_ID",
  "allowedGuildIds": ["YOUR_GUILD_ID"],
  "hostChannelName": "host"
}
```

**Field explanations:**

- `discordToken` — Bot token from Discord Developer Portal (required)
- `discordApplicationId` — Application ID (required for slash commands)
- `ownerUserId` — Your Discord user ID for admin commands (required)
- `allowedGuildIds` — Which guilds picord operates in (empty allows all, but restrict for prod)
- `hostChannelName` — Text channel name used for control commands (default: `host`)
- `statePath` — Where credentials/session state are stored (default: `./picord.state.json`)
- `workspaceBasePath` — Base path for project workspaces (default: `~/.picord/workspace`)
- `multiAuth` — Multi-auth provider configuration (see below)

For detailed field descriptions, see `picord.config.example.json`.

---

## Step 4: Set Environment Variables (Optional)

Instead of putting secrets in the config file, you can use environment variables:

```bash
export PICORD_DISCORD_TOKEN="your-bot-token"
export PICORD_DISCORD_APPLICATION_ID="your-application-id"
```

The environment overrides config file values.

### Encryption Key (Recommended)

To encrypt stored credentials, set `PICORD_ENCRYPTION_KEY`:

```bash
# Generate a secure key
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Set it as an environment variable
export PICORD_ENCRYPTION_KEY="your-generated-key-here"
```

**Important:**
- Store this key securely (e.g., in a password manager)
- Without this key, credentials are stored in plaintext
- If you lose the key, encrypted credentials cannot be recovered

---

## Step 5: Build Picord

```bash
npm run build
```

---

## Step 6: Register Slash Commands

```bash
npm run sync:discord-commands
```

This registers all slash commands (`/ask`, `/login`, `/multi-auth`, etc.) to your Discord application in the configured guilds.

**Note:** If you add new commands or change command definitions, re-run this.

---

## Step 7: Run Picord

```bash
npm run picord:start
```

Or manually:

```bash
node dist/index.js
```

Picord will connect to Discord and print status.

---

## Step 8: Test in Discord

- In your guild, find the **host channel** (named `host` by default)
- Create a project channel with `/project-create name=myproject`
- Start a thread in that channel and use `/ask` to verify responses

---

## Multi‑Auth Setup (Optional)

Picord supports multiple credentials per provider via `/login` and `/multi-auth` commands.

Add multi-auth config to `picord.config.json`:

```json
{
  "multiAuth": {
    "enabled": true,
    "excludeProviders": [],
    "debug": false
  }
}
```

Then use:

- `/login` — Add credentials (OAuth flow or API key modal)
- `/multi-auth` — Status, delete, switch, rename, rotation, hide
- `/usage` — Show rate limits/quota for your credentials

Credentials are stored encrypted in `picord.state.json` (local only).

---

## Troubleshooting

**Bot appears online but commands don't show up:**
- Ensure `discordApplicationId` is set and matches your bot's Application ID
- Re‑run `npm run sync:discord-commands`
- Check bot has `applications.commands` scope in OAuth2 → URL Generator
- Wait up to 1 hour for global commands; guild commands appear instantly

**Missing `MessageContent` intent:**
- Enable **Message Content Intent** in Discord Developer Portal → Bot → Privileged Gateway Intents
- If you can't enable it, picord falls back to slash‑only mode (still works)

**No responses in threads:**
- Make sure you're in a managed project channel or thread
- Check picord logs for access denied errors
- Verify `allowedGuildIds` includes your guild

**Credential upload concerns:**
- All credentials stay in `picord.state.json` on your machine
- Multi-auth only sends credentials to the respective provider APIs (OpenAI, Anthropic, etc.) during normal operation
- No telemetry is sent to remotepicord servers

**Credentials stored in plaintext warning:**
- Set `PICORD_ENCRYPTION_KEY` environment variable to enable encryption
- Run `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` to generate a key

---

## Advanced: Separate Config File

You can keep your config outside the repository (e.g., `~/.config/picord/config.json`):

```bash
export PICORD_CONFIG="/path/to/picord.config.json"
```

Then keep `picord.config.json` in the repo as a template (copy and adjust paths).

---

## Uninstall

Stop the running picord process. Remove the cloned repository if desired. Delete `picord.state.json` to clear credentials (optional).
