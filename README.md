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

#### Writing your CLAUDE.md

The `CLAUDE.md` is the bot's brain — it controls what Claude knows, how it behaves, and what it can do. The Discord bot needs a **lightweight** version compared to what you'd use in a terminal/IDE session. Claude loads the full `CLAUDE.md` on every message, so keep it lean.

Start from the example and customize:

```bash
cp CLAUDE.md.example CLAUDE.md
```

**Key sections to include:**

| Section | Purpose | Example |
|---|---|---|
| **Role** | Who the bot is and who it works for | "You are a product assistant for Acme Corp" |
| **Quick lookups** | What the bot can query directly | "Query Postgres via MCP, check Stripe billing" |
| **Context files** | Files to read on demand (not on every message) | "Read `docs/roadmap.md` only when asked about roadmap" |
| **Actions** | What the bot is allowed to do | "Create GitHub issues, commit and push" |
| **Terminology** | Domain-specific terms | "Golden Model = canonical output schema" |
| **Repos** | Where to file issues and find code | "acme/backend — main API server" |

**Guidelines:**

- **Keep it under 100 lines.** If Claude has to read 500 lines of context on every Discord message, it wastes tokens and slows responses.
- **Load context on demand.** Don't paste your entire architecture doc into `CLAUDE.md`. Instead, list the file paths and tell Claude to read them only when relevant.
- **Skip startup rituals.** Tell Claude not to read files or run commands unless the question requires it.
- **Be brief.** Remind Claude that Discord has a 2000-char limit and to keep responses concise.

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

## Managing the bot

The built-in process manager handles start, stop, and restart with PID file tracking. Works on Linux, macOS, and Windows.

```bash
npm start          # start bot in background
npm stop           # graceful shutdown
npm restart        # stop + start
npm run status     # show PID, uptime, recent logs
npm run logs       # tail last 20 lines of bot.log
npm run logs 50    # tail last 50 lines
```

The manager writes a `.bot.pid` file to track the running process. `npm start` will refuse to start a second instance. `npm stop` sends SIGINT for graceful shutdown (5s timeout, then force kill).

### Running as a system service

For auto-restart on crashes or reboots, use a system service manager instead of the built-in manager.

**With pm2:**

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

> **Note:** When using pm2 or systemd, don't mix with `npm start/stop` — use one or the other.

## How to use

- **DM the bot** — it responds to all direct messages
- **Mention in a server** — `@YourBot what's the status of open issues?`
- **Monitored channels** — set `MONITOR_CHANNELS` in `.env` to have the bot respond to all messages in specific channels (no @mention needed)
- `/new` — clears the session, starts fresh
- `/status` — shows current session info

### How sessions work

Each Discord channel gets its own Claude Code session. Messages in the same channel continue the conversation with full context — sessions persist until you type `/new` or the bot restarts. Claude Code stores sessions on disk, so even after hours of inactivity the bot picks up right where it left off.

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
| `CLAUDE_CWD` | current directory | **Your project repo** — where `CLAUDE.md`, `.mcp.json`, and `.claude/commands/` live |
| `ALLOWED_USERS` | (all users) | Comma-separated Discord user IDs to restrict access |
| `MONITOR_CHANNELS` | (none) | Channels where bot responds without @mention |
| `ALLOWED_BOTS` | (none) | Bot user IDs allowed to interact (enables bot-to-bot communication) |
| `MAX_BOT_EXCHANGES` | `2` | Max back-and-forth with another bot before stopping (prevents loops) |
| `BOT_SYSTEM_PROMPT` | (built-in) | Override the system prompt appended to every Claude session |
| `SESSION_TIMEOUT_MS` | `1800000` | Session inactivity timeout (ms). Default: 30 minutes |
| `CLAUDE_TIMEOUT_MS` | `3600000` | Max time per Claude session (ms). Default: 1 hour |
| `CLAUDE_BIN` | `claude` | Path to Claude Code binary |
| `LOG_LEVEL` | `info` | Pino log level: `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | (none) | Set to `production` to disable pretty logging |

**Finding Discord IDs:** Enable Developer Mode in Discord (Settings > Advanced > Developer Mode), then right-click users/channels to copy their IDs.

### Bot-to-bot communication

By default, Discord bots ignore messages from other bots. If you're running multiple bot instances (e.g., a Product Owner bot and an SRE bot) that need to talk to each other, **both bots must whitelist the other**.

Each bot needs the other bot's **user ID** (not client ID) in its `ALLOWED_BOTS`:

```env
# Bot A's .env — allow Bot B to talk to it
ALLOWED_BOTS=<bot-b-user-id>

# Bot B's .env — allow Bot A to talk to it
ALLOWED_BOTS=<bot-a-user-id>
```

To find a bot's user ID: right-click the bot's name in Discord (with Developer Mode enabled) → **Copy User ID**. You can also find it on the bot's OAuth2 authorize URL — the `client_id` parameter is the same as the user ID.

**Without this, @mentions between bots will be silently ignored.** This is the most common issue when setting up multi-bot workflows. If a bot responds to humans but not to another bot, `ALLOWED_BOTS` is the fix.

#### Loop prevention

When two bots can talk to each other, they can get into an infinite loop — each responding to the other's last message. The bot automatically stops after `MAX_BOT_EXCHANGES` consecutive bot-to-bot exchanges in the same channel (default: 2). Any human message in that channel resets the counter.

```env
# Allow up to 3 back-and-forth exchanges before stopping (default: 2)
MAX_BOT_EXCHANGES=3
```

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

### Bot ignores @mentions from another bot

This is expected by default — bots ignore all other bots. To enable bot-to-bot communication, add the other bot's user ID to `ALLOWED_BOTS` in `.env`. **Both bots must whitelist each other.** See [Bot-to-bot communication](#bot-to-bot-communication) above.

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
