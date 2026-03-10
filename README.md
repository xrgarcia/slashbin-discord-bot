# slashbin-discord-bot

A Discord bot that wraps [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, giving you a conversational AI assistant in Discord with full access to your codebase, MCP servers, and tools.

Built for product owner workflows but works for any team that wants Claude Code in Discord.

## What it does

- Spawns Claude Code CLI sessions per Discord channel
- Streams intermediate progress messages (not just the final answer)
- Resumes conversations within the same channel (30-min session window)
- Structured logging with [pino](https://github.com/pinojs/pino)
- Connects to any MCP servers you configure (Stripe, Postgres, Railway, etc.)
- Respects Discord's 2000-char limit with smart message splitting

## Prerequisites

- **Node.js** 18+
- **Claude Code CLI** installed and authenticated ([install guide](https://docs.anthropic.com/en/docs/claude-code/getting-started))
- A **Discord bot token** ([Discord Developer Portal](https://discord.com/developers/applications))

## Setup

### 1. Create a Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, give it a name
3. Go to **Bot** tab, click **Reset Token**, copy the token
4. Under **Privileged Gateway Intents**, enable **Message Content Intent**
5. Go to **OAuth2 > URL Generator**, select scopes: `bot`, permissions: `Send Messages`, `Read Message History`
6. Open the generated URL to invite the bot to your server

### 2. Clone and install

```bash
git clone https://github.com/xrgarcia/slashbin-discord-bot.git
cd slashbin-discord-bot
npm install
```

### 3. Configure

The repo ships three `.example` files. Copy each one and customize:

```bash
cp .env.example .env
cp CLAUDE.md.example CLAUDE.md
cp .mcp.json.example .mcp.json    # optional
```

**`.env`** — Discord token and access control:

```env
# Required
DISCORD_TOKEN=your-discord-bot-token-here

# Optional: restrict to specific Discord user IDs (comma-separated)
ALLOWED_USERS=

# Optional: channels where bot responds to ALL messages (no @mention needed)
MONITOR_CHANNELS=
```

**`CLAUDE.md`** — The bot's brain. Customize with your product context, available tools, terminology, and behavioral rules. This is the system prompt that shapes how Claude responds.

**`.mcp.json`** — MCP servers the bot connects to (Stripe, Postgres, etc.). Remove this file if you don't need any.

> **Note:** Claude waits for all MCP servers to connect before responding. If a server hangs (e.g., unreachable database), the bot will appear stuck. Test servers individually first.

**Finding Discord IDs:** Enable Developer Mode in Discord (Settings > Advanced > Developer Mode), then right-click users/channels to copy their IDs.

### 4. Run

```bash
npm start
```

Or with pretty logs in development:

```bash
node bot.js
```

For production, run with a process manager:

```bash
# With nohup
nohup node bot.js >> /tmp/bot.log 2>&1 &

# Or use pm2, systemd, etc.
```

## Usage

### In monitored channels
Just type a message — the bot responds to everything.

### In other channels
@mention the bot: `@BotName what's the current customer count?`

### Commands

| Command | Description |
|---------|-------------|
| `/new` | Clear the current session and start fresh |
| `/status` | Show the current session ID and age |

### How sessions work

Each Discord channel gets its own Claude Code session. Messages in the same channel continue the conversation (with full context) for 30 minutes. After 30 minutes of inactivity, the next message starts a fresh session.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | (required) | Discord bot token |
| `ALLOWED_USERS` | (all users) | Comma-separated Discord user IDs |
| `MONITOR_CHANNELS` | (none) | Channels where bot responds without @mention |
| `CLAUDE_BIN` | `claude` | Path to Claude Code binary |
| `CLAUDE_TIMEOUT_MS` | `3600000` | Max time per Claude session (ms). Default: 1 hour |
| `LOG_LEVEL` | `info` | Pino log level: `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | (none) | Set to `production` to disable pretty logging |

## Architecture

```
Discord message
  → bot.js receives via discord.js
  → spawns `claude` CLI with --output-format stream-json
  → streams events back as Discord messages
  → session ID saved for conversation continuity
```

Key design decisions:
- **CLI spawn, not SDK** — uses Claude Code CLI directly, getting all built-in tools (Bash, Read, Edit, Grep, etc.) and MCP server support for free
- **stdin: "ignore"** — critical fix; without this, Claude hangs waiting for interactive consent
- **Stream processing** — text is sent to Discord as it arrives (before tool calls), so users see progress during long research tasks
- **Send queue** — messages are serialized to avoid Discord rejecting overlapping replies

## Customization

All personalization lives in three gitignored files — the bot code itself is generic:

| File | Purpose |
|---|---|
| `CLAUDE.md` | System prompt — what the bot knows, how it behaves |
| `.mcp.json` | MCP servers — databases, APIs, external tools |
| `.env` | Secrets and access control |

### Add file access
Use `--add-dir` in the spawn args (in `bot.js`) to give Claude read/write access to additional directories.

### Change the model
Set `--model` in the spawn args. Defaults to whatever your Claude Code CLI is configured to use.

## License

ISC
