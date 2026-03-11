require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { spawn } = require("child_process");
const { readFileSync, writeFileSync, readdirSync } = require("fs");
const { join } = require("path");
const pino = require("pino");

// --- Logger ---
const log = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV !== "production"
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
});

// --- Config ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_CWD = process.env.CLAUDE_CWD || process.cwd();
const MAX_DISCORD_LENGTH = parseInt(process.env.MAX_DISCORD_LENGTH, 10) || 1900;
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS, 10) || 30 * 60 * 1000;
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || 3600000; // 1 hour default
const ALLOWED_USER_IDS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(",").filter(Boolean)
  : [];
const MONITOR_CHANNELS = process.env.MONITOR_CHANNELS
  ? process.env.MONITOR_CHANNELS.split(",").filter(Boolean)
  : [];
const ALLOWED_BOTS = process.env.ALLOWED_BOTS
  ? process.env.ALLOWED_BOTS.split(",").filter(Boolean)
  : [];
const MAX_BOT_EXCHANGES = parseInt(process.env.MAX_BOT_EXCHANGES, 10) || 2;
const REMEMBER_MAX_MESSAGES = parseInt(process.env.REMEMBER_MAX_MESSAGES, 10) || 100;
const REMEMBER_MAX_CHANNELS = parseInt(process.env.REMEMBER_MAX_CHANNELS, 10) || 10;

if (!DISCORD_TOKEN) {
  log.fatal("DISCORD_TOKEN environment variable is required");
  process.exit(1);
}

// --- Session tracking (disk-backed) ---
const SESSION_FILE = join(__dirname, ".bot-sessions.json");

function loadSessions() {
  try {
    const data = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function saveSessions() {
  try {
    const obj = Object.fromEntries(sessions);
    writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    log.warn({ err }, "Failed to persist sessions");
  }
}

const sessions = loadSessions();
if (sessions.size > 0) {
  log.info({ restored: sessions.size }, "Restored sessions from disk");
}

// --- Bot-to-bot exchange tracking ---
// Tracks consecutive bot↔bot exchanges per channel to prevent infinite loops.
// Key: channelId, Value: { count: number, lastBotId: string }
// Resets when a human sends a message in the channel.
const botExchanges = new Map();

// --- Discord history fetching for /remember ---
async function fetchChannelHistory(channelIds, reqLog) {
  const history = [];

  for (const channelId of channelIds.slice(0, REMEMBER_MAX_CHANNELS)) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) continue;

      const channelName = channel.name || `DM-${channelId}`;
      const messages = await channel.messages.fetch({ limit: REMEMBER_MAX_MESSAGES });

      // Sort oldest first for chronological reading
      const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      for (const m of sorted) {
        history.push({
          channel: channelName,
          author: m.author.tag,
          timestamp: m.createdAt.toISOString(),
          content: m.content.substring(0, 2000),
        });
      }

      reqLog.debug({ channelId, channelName, fetched: sorted.length }, "Fetched channel history");
    } catch (err) {
      reqLog.warn({ channelId, err: err.message }, "Failed to fetch channel history");
    }
  }

  return history;
}

function formatHistoryForPrompt(history) {
  if (history.length === 0) return "(No Discord chat history found)";

  return history
    .map((m) => `[${m.timestamp}] #${m.channel} | ${m.author}: ${m.content}`)
    .join("\n");
}

function loadStoredSummaries() {
  const historyDir = join(__dirname, ".bot-history");
  try {
    const files = readdirSync(historyDir).filter((f) => f.endsWith(".md") && !f.startsWith("."));
    // Sort newest first so most recent summaries come first
    files.sort().reverse();
    const summaries = [];
    for (const file of files) {
      try {
        const content = readFileSync(join(historyDir, file), "utf8");
        summaries.push({ file, content });
      } catch { /* skip unreadable */ }
    }
    return summaries;
  } catch {
    return [];
  }
}

// --- Discord client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  log.info({ tag: client.user.tag, cwd: CLAUDE_CWD }, "Bot online");
  log.info(
    { allowedUsers: ALLOWED_USER_IDS.length || "all", monitoredChannels: MONITOR_CHANNELS },
    "Access config"
  );
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot && !ALLOWED_BOTS.includes(msg.author.id)) return;

  if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(msg.author.id)) {
    return;
  }

  const isDM = !msg.guild;
  const isMentioned = msg.mentions.has(client.user);
  const isMonitored = MONITOR_CHANNELS.includes(msg.channel.id);
  if (!isDM && !isMentioned && !isMonitored) return;

  // Bot-to-bot loop prevention
  if (msg.author.bot) {
    const exchange = botExchanges.get(msg.channel.id) || { count: 0 };
    exchange.count++;
    botExchanges.set(msg.channel.id, exchange);
    if (exchange.count > MAX_BOT_EXCHANGES) {
      log.info({ channel: msg.channel.id, count: exchange.count, bot: msg.author.tag }, "Bot exchange limit reached, ignoring");
      return;
    }
  } else {
    // Human message resets the counter
    botExchanges.delete(msg.channel.id);
  }

  let prompt = msg.content
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .trim();
  if (!prompt) return;

  const reqLog = log.child({ channel: msg.channel.id, user: msg.author.tag, prompt: prompt.substring(0, 80) });

  // Handle special commands
  if (prompt === "/new") {
    sessions.delete(msg.channel.id);
    saveSessions();
    reqLog.info("Session cleared by user");
    await msg.reply("Session cleared. Next message starts a fresh conversation.");
    return;
  }

  if (prompt === "/status") {
    const session = sessions.get(msg.channel.id);
    const status = session
      ? `Active session: \`${session.sessionId}\` (last used ${Math.round((Date.now() - session.lastUsed) / 1000)}s ago)`
      : "No active session";
    await msg.reply(status);
    return;
  }

  if (prompt.startsWith("/remember")) {
    const query = prompt.replace(/^\/remember\s*/, "").trim();
    if (!query) {
      await msg.reply("Usage: `/remember <what you want to recall>`\nExample: `/remember the conversation about retry logic`");
      return;
    }

    reqLog.info({ query }, "Remember command");
    const typing = setInterval(() => msg.channel.sendTyping(), 8000);
    msg.channel.sendTyping();

    try {
      // Collect channels the bot has sessions in + current channel
      const channelIds = new Set([msg.channel.id, ...sessions.keys()]);
      const history = await fetchChannelHistory([...channelIds], reqLog);
      const historyText = formatHistoryForPrompt(history);

      // Load stored summaries from .bot-history/
      const summaries = loadStoredSummaries();

      reqLog.info({ channels: channelIds.size, messages: history.length, summaries: summaries.length }, "Fetched history for /remember");

      const summaryText = summaries.length > 0
        ? summaries.map((s) => `### ${s.file}\n${s.content}`).join("\n\n")
        : "(No stored summaries found. Run `node summarize.js` to generate them.)";

      const rememberPrompt = [
        `The user is asking you to recall: "${query}"`,
        "",
        "Search the following sources to find relevant information:",
        "",
        "## Source 1: Recent Discord Messages",
        "Below are recent messages from Discord channels this bot participates in.",
        "",
        "```",
        historyText,
        "```",
        "",
        "## Source 2: Stored Chat Summaries",
        "Below are summaries of older Discord conversations, generated by a background summarizer.",
        "These cover history beyond the recent messages above.",
        "",
        summaryText,
        "",
        "## Source 3: Local Knowledge (search these yourself)",
        "- CLAUDE.md in the current working directory — system context and rules",
        "- docs/ directory — architecture, runbooks, incidents, schemas",
        "- .claude/ directory — memory files with persistent knowledge",
        "- ~/.claude/ directory — past conversation transcripts (JSONL files)",
        "",
        "## Instructions",
        "1. Search the recent Discord messages for relevant conversations",
        "2. Search the stored summaries for older relevant context",
        "3. Use your file reading tools to search local files for related context",
        "4. Synthesize what you find into a clear, concise answer",
        "5. Cite sources: quote Discord messages with timestamps, reference summary dates, or file paths",
        "6. If you find nothing relevant, say so honestly",
      ].join("\n");

      const sendQueue = createSendQueue(msg, reqLog);

      // Use a fresh session for /remember — don't pollute the channel's ongoing conversation
      await runClaudeRemember(rememberPrompt, reqLog, sendQueue.enqueue);
      clearInterval(typing);
      await sendQueue.flush();
    } catch (err) {
      clearInterval(typing);
      reqLog.error({ err }, "Remember command failed");
      await msg.reply(`Error: ${err.message}`);
    }
    return;
  }

  const typing = setInterval(() => msg.channel.sendTyping(), 8000);
  msg.channel.sendTyping();

  // Queue for sending messages to Discord without overlap
  const sendQueue = createSendQueue(msg, reqLog);

  try {
    await runClaude(prompt, msg.channel.id, reqLog, sendQueue.enqueue);
    clearInterval(typing);
    await sendQueue.flush();
  } catch (err) {
    clearInterval(typing);
    await sendQueue.flush();
    reqLog.error({ err }, "Claude invocation failed");
    await msg.reply(`Error: ${err.message}`);
  }
});

// --- Send queue: serializes Discord messages to avoid race conditions ---
function createSendQueue(msg, reqLog) {
  const pending = [];
  let sending = false;

  async function drain() {
    if (sending) return;
    sending = true;
    while (pending.length > 0) {
      const text = pending.shift();
      const chunks = splitMessage(text);
      for (const chunk of chunks) {
        try {
          await msg.reply(chunk);
        } catch (err) {
          reqLog.error({ err }, "Failed to send Discord message");
        }
      }
    }
    sending = false;
  }

  return {
    enqueue(text) {
      if (!text || !text.trim()) return;
      pending.push(text);
      drain();
    },
    async flush() {
      // Wait for all pending sends to complete
      while (pending.length > 0 || sending) {
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}

function runClaude(prompt, channelId, reqLog, sendMessage) {
  return new Promise((resolve, reject) => {
    const session = sessions.get(channelId);

    const systemPrompt = process.env.BOT_SYSTEM_PROMPT ||
      "You are running inside a Discord bot. Keep responses concise — Discord has a 2000 char limit per message. Do NOT perform startup rituals. Be brief.";

    const args = [
      "--output-format", "stream-json",
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
      "--verbose",
      "--append-system-prompt", systemPrompt,
    ];

    if (session) {
      const idleMs = Date.now() - session.lastUsed;
      args.push("--resume", session.sessionId, "-p", prompt);
      if (idleMs > SESSION_TIMEOUT_MS) {
        reqLog.info({ sessionId: session.sessionId, idleMin: Math.round(idleMs / 60000) }, "Resuming stale session");
      } else {
        reqLog.info({ sessionId: session.sessionId }, "Resuming session");
      }
    } else {
      args.push("-p", prompt);
      reqLog.info("Starting new Claude session");
    }

    // Build a clean env without Claude nesting vars
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_AGENT_SDK_VERSION;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
    delete cleanEnv.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING;

    const startTime = Date.now();
    const child = spawn(CLAUDE_BIN, args, {
      cwd: CLAUDE_CWD,
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLAUDE_TIMEOUT_MS,
    });

    let sessionId = null;
    let buffer = "";
    let turnText = ""; // text accumulated in the current assistant turn

    child.stdout.on("data", (data) => {
      buffer += data.toString();

      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          handleStreamEvent(event, reqLog, sendMessage, (id) => { sessionId = id; }, {
            getTurnText: () => turnText,
            setTurnText: (t) => { turnText = t; },
          });
        } catch {
          reqLog.warn({ raw: line.substring(0, 200) }, "Non-JSON line from Claude");
        }
      }
    });

    child.stderr.on("data", (data) => {
      reqLog.warn({ stderr: data.toString().trim() }, "Claude stderr");
    });

    child.on("close", (code) => {
      const elapsed = Date.now() - startTime;

      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          handleStreamEvent(event, reqLog, sendMessage, (id) => { sessionId = id; }, {
            getTurnText: () => turnText,
            setTurnText: (t) => { turnText = t; },
          });
        } catch {
          // ignore
        }
      }

      // Send any remaining text from the last turn
      if (turnText.trim()) {
        sendMessage(turnText);
        turnText = "";
      }

      if (code !== 0) {
        reqLog.error({ code, elapsed }, "Claude exited with non-zero code");
        reject(new Error(`Claude exited with code ${code} after ${Math.round(elapsed / 1000)}s`));
        return;
      }

      if (sessionId) {
        sessions.set(channelId, { sessionId, lastUsed: Date.now() });
        saveSessions();
      }

      reqLog.info({ elapsed, sessionId }, "Claude completed");
      resolve();
    });

    child.on("error", (err) => {
      reqLog.error({ err }, "Failed to spawn Claude");
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

function runClaudeRemember(prompt, reqLog, sendMessage) {
  return new Promise((resolve, reject) => {
    const systemPrompt = "You are a recall assistant. Search all available sources to answer the user's query. Be thorough but concise — Discord has a 2000 char limit. Cite timestamps and file paths.";

    const args = [
      "--output-format", "stream-json",
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
      "--verbose",
      "--append-system-prompt", systemPrompt,
      "-p", prompt,
    ];

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_AGENT_SDK_VERSION;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
    delete cleanEnv.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING;

    const startTime = Date.now();
    const child = spawn(CLAUDE_BIN, args, {
      cwd: CLAUDE_CWD,
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLAUDE_TIMEOUT_MS,
    });

    let buffer = "";
    let turnText = "";

    child.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          handleStreamEvent(event, reqLog, sendMessage, () => {}, {
            getTurnText: () => turnText,
            setTurnText: (t) => { turnText = t; },
          });
        } catch {
          // skip non-JSON
        }
      }
    });

    child.stderr.on("data", (data) => {
      reqLog.warn({ stderr: data.toString().trim() }, "Claude remember stderr");
    });

    child.on("close", (code) => {
      const elapsed = Date.now() - startTime;

      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          handleStreamEvent(event, reqLog, sendMessage, () => {}, {
            getTurnText: () => turnText,
            setTurnText: (t) => { turnText = t; },
          });
        } catch { /* ignore */ }
      }

      if (turnText.trim()) {
        sendMessage(turnText);
      }

      if (code !== 0) {
        reqLog.error({ code, elapsed }, "Claude remember exited with non-zero code");
        reject(new Error(`Claude exited with code ${code} after ${Math.round(elapsed / 1000)}s`));
        return;
      }

      reqLog.info({ elapsed }, "Claude remember completed");
      resolve();
    });

    child.on("error", (err) => {
      reqLog.error({ err }, "Failed to spawn Claude for remember");
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

function handleStreamEvent(event, reqLog, sendMessage, setSessionId, turnState) {
  switch (event.type) {
    case "system":
      if (event.session_id) setSessionId(event.session_id);
      reqLog.info({ sessionId: event.session_id }, "Claude session started");
      break;

    case "assistant":
      if (event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text") {
            // Accumulate text for this turn
            turnState.setTurnText(turnState.getTurnText() + block.text);
          } else if (block.type === "tool_use") {
            // Tool call coming — send any accumulated text first so user sees progress
            const pending = turnState.getTurnText();
            if (pending.trim()) {
              sendMessage(pending);
              turnState.setTurnText("");
            }
            reqLog.info({ tool: block.name, inputPreview: JSON.stringify(block.input).substring(0, 120) }, "Tool call");
          }
        }
      }
      break;

    case "result":
      if (event.session_id) setSessionId(event.session_id);
      reqLog.info(
        { costUsd: event.cost_usd, durationMs: event.duration_ms, inputTokens: event.total_input_tokens, outputTokens: event.total_output_tokens },
        "Claude result summary"
      );
      break;

    default:
      reqLog.debug({ type: event.type }, "Stream event");
      break;
  }
}

function splitMessage(text) {
  if (text.length <= MAX_DISCORD_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_DISCORD_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", MAX_DISCORD_LENGTH);
    if (splitAt < MAX_DISCORD_LENGTH / 2) {
      splitAt = remaining.lastIndexOf(" ", MAX_DISCORD_LENGTH);
    }
    if (splitAt < MAX_DISCORD_LENGTH / 2) {
      splitAt = MAX_DISCORD_LENGTH;
    }

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  return chunks;
}

// Log session count every 10 minutes (sessions persist until /new or bot restart)
setInterval(() => {
  if (sessions.size > 0) {
    log.debug({ activeSessions: sessions.size }, "Session inventory");
  }
}, 10 * 60 * 1000);

// Graceful shutdown
process.on("SIGINT", () => {
  log.info("Shutting down...");
  client.destroy();
  process.exit(0);
});

client.login(DISCORD_TOKEN);
