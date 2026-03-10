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

```bash
cp .env.example .env
```

At minimum, edit `.env` and add your Discord token:

```env
DISCORD_TOKEN=your-discord-bot-token-here
```

### Step 4: Set up your project directory

The bot is designed to run from your **project directory** — the repo that has your `CLAUDE.md`, `.mcp.json`, and Claude Code skills (`.claude/commands/`). This is how the bot gets its personality, context, and capabilities.

```bash
# Set CLAUDE_CWD in .env to your project repo
CLAUDE_CWD=/path/to/your/project-repo
```

In your project repo, make sure you have:
- **`CLAUDE.md`** — the bot's brain. Defines what it knows, what it can do, and how it behaves.
- **`.mcp.json`** (optional) — MCP servers for databases, APIs, and external tools.
- **`.claude/commands/`** (optional) — Claude Code skills the bot can invoke.

> **Why not run from the bot directory?** The bot code is generic — it's just the Discord ↔ Claude bridge. All the intelligence comes from your project's `CLAUDE.md`, MCP servers, and skills. Running from the project directory gives Claude full access to your codebase, context, and tools.

If you don't have a separate project repo, the bot will use its own directory. Copy the example files to get started:

```bash
cp CLAUDE.md.example CLAUDE.md
cp .mcp.json.example .mcp.json    # optional
```

### Step 5: Run

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
| `CLAUDE_CWD` | current directory | **Your project repo** — where `CLAUDE.md`, `.mcp.json`, and `.claude/commands/` live |
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

## Troubleshooting

### Bot sends a message but it's empty or gets no response

Claude is hanging. The most common cause is `stdin` — Claude's CLI expects an interactive terminal and blocks waiting for consent. The bot sets `stdio: ["ignore", "pipe", "pipe"]` to prevent this. If you've modified the spawn options, make sure stdin is set to `"ignore"`.

### Bot appears stuck after receiving a message

Check if an MCP server is unreachable. Claude waits for **all** MCP servers to connect before it starts processing. One hanging server blocks everything.

To diagnose, remove `.mcp.json` temporarily and test. Add servers back one at a time.

### Error code 143

Claude was killed by a timeout (`SIGTERM`). The default timeout is 1 hour (`CLAUDE_TIMEOUT_MS=3600000`). If your tasks need more time, increase it in `.env`. If the task should have been fast, check for hanging MCP servers (see above).

### Claude hangs when spawned from inside another Claude session

The bot strips Claude-specific environment variables (`CLAUDECODE`, `CLAUDE_AGENT_SDK_VERSION`, etc.) before spawning. If you're running the bot from within a Claude Code terminal and it still hangs, check that the `cleanEnv` block in `bot.js` is removing all `CLAUDE_*` vars.

### Discord rejects messages (no error, message just doesn't appear)

Discord has a 2000 character limit per message. The bot splits long responses automatically, but if you see missing messages, check the logs for send errors:

```bash
grep "Failed to send" bot.log
```

### Bot responds but doesn't see my messages

Make sure **Message Content Intent** is enabled in the [Discord Developer Portal](https://discord.com/developers/applications) under your bot's **Privileged Gateway Intents**. Without it, the bot receives empty message bodies.

### "Claude exited with code 1"

Usually means Claude CLI isn't authenticated. Run `claude` manually in your terminal to check. You may need to run `claude auth` first.

### Logs show "Non-JSON line from Claude"

This is usually harmless — Claude CLI sometimes outputs non-JSON warnings to stdout (e.g., deprecation notices). The bot skips these lines. If you see many of them, set `LOG_LEVEL=debug` to investigate.

## License

ISC
