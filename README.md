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

## Getting started

### Step 1: Create a Discord bot (5 minutes)

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → name it whatever you want (e.g. "My AI Assistant")
3. Go to **Bot** tab → click **Reset Token** → copy the token
4. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** (required to read messages)
5. Go to **OAuth2** tab → **URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`
6. Copy the generated URL → open it → invite the bot to your Discord server

### Step 2: Clone and install

```bash
git clone https://github.com/xrgarcia/slashbin-discord-bot.git
cd slashbin-discord-bot
npm install
```

### Step 3: Configure

The repo ships three `.example` files. Copy each one and customize:

```bash
cp .env.example .env
cp CLAUDE.md.example CLAUDE.md
cp .mcp.json.example .mcp.json    # optional — only if you need MCP servers
```

At minimum, edit `.env` and add your Discord token:

```env
DISCORD_TOKEN=your-discord-bot-token-here
```

Edit `CLAUDE.md` to customize what the bot knows and how it behaves. This is the system prompt — it's the bot's brain.

### Step 4: Run

```bash
npm start
```

That's it. The bot is online.

## How to use

- **DM the bot** — it responds to all direct messages
- **Mention in a server** — `@YourBot what's the status of open issues?`
- **Monitored channels** — set `MONITOR_CHANNELS` in `.env` to have the bot respond to all messages in specific channels (no @mention needed)
- `/new` — clears the session, starts fresh
- `/status` — shows current session info

### How sessions work

Each Discord channel gets its own Claude Code session. Messages in the same channel continue the conversation (with full context) for 30 minutes. After 30 minutes of inactivity, the next message starts a fresh session.

## Running as a daemon

For always-on use, run the bot as a background process that survives terminal closes and restarts on crashes.

**With pm2** (recommended):

```bash
npm install -g pm2
pm2 start bot.js --name discord-bot
pm2 save        # persist across reboots
pm2 logs        # tail logs
pm2 restart discord-bot  # restart after config changes
```

**With systemd** (Linux):

```ini
# /etc/systemd/system/discord-bot.service
[Unit]
Description=Claude Code Discord Bot
After=network.target

[Service]
Type=simple
User=your-user
WorkingDir=/path/to/slashbin-discord-bot
ExecStart=/usr/bin/node bot.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable discord-bot
sudo systemctl start discord-bot
journalctl -u discord-bot -f  # tail logs
```

**With nohup** (quick and simple):

```bash
nohup node bot.js >> bot.log 2>&1 &
```

> **Note:** `nohup` won't auto-restart on crashes. Use pm2 or systemd for production.

## Configuration

All personalization lives in three gitignored files — the bot code itself is generic:

| File | Purpose |
|---|---|
| `.env` | Secrets and access control |
| `CLAUDE.md` | System prompt — what the bot knows, how it behaves |
| `.mcp.json` | MCP servers — databases, APIs, external tools (optional) |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | (required) | Discord bot token |
| `ALLOWED_USERS` | (all users) | Comma-separated Discord user IDs to restrict access |
| `MONITOR_CHANNELS` | (none) | Channels where bot responds without @mention |
| `CLAUDE_CWD` | current directory | Working directory for Claude sessions — point at the repo with your `CLAUDE.md` and `.mcp.json` |
| `CLAUDE_BIN` | `claude` | Path to Claude Code binary |
| `CLAUDE_TIMEOUT_MS` | `3600000` | Max time per Claude session (ms). Default: 1 hour |
| `LOG_LEVEL` | `info` | Pino log level: `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | (none) | Set to `production` to disable pretty logging |

**Finding Discord IDs:** Enable Developer Mode in Discord (Settings > Advanced > Developer Mode), then right-click users/channels to copy their IDs.

### MCP servers

Edit `.mcp.json` to connect databases, APIs, and other tools:

```json
{
  "mcpServers": {
    "stripe": {
      "command": "npx",
      "args": ["-y", "@stripe/mcp"]
    },
    "my-database": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://..."]
    }
  }
}
```

> **Note:** Claude waits for all MCP servers to connect before responding. If a server hangs (e.g., unreachable database), the bot will appear stuck. Test servers individually first.

### Customization

- **Change what Claude knows** — edit `CLAUDE.md` with your product context, terminology, and behavioral rules
- **Add file access** — use `--add-dir` in the spawn args (in `bot.js`) to give Claude read/write access to additional directories
- **Change the model** — set `--model` in the spawn args. Defaults to whatever your Claude Code CLI is configured to use

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

## License

ISC
