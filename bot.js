require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { spawn } = require("child_process");
const { readFileSync, writeFileSync, mkdirSync } = require("fs");
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
const SUMMARIZE_INTERVAL_MS = parseInt(process.env.SUMMARIZE_INTERVAL_MS, 10) || 0; // 0 = disabled
const SUMMARIZE_CHANNELS = process.env.SUMMARIZE_CHANNELS
  ? process.env.SUMMARIZE_CHANNELS.split(",").filter(Boolean)
  : MONITOR_CHANNELS;
const SUMMARIZE_BATCH_SIZE = parseInt(process.env.SUMMARIZE_BATCH_SIZE, 10) || 200;
const RECENT_CONTEXT_HOURS = parseFloat(process.env.RECENT_CONTEXT_HOURS) || 1;
const RECENT_CONTEXT_CHANNELS = process.env.RECENT_CONTEXT_CHANNELS
  ? process.env.RECENT_CONTEXT_CHANNELS.split(",").filter(Boolean)
  : MONITOR_CHANNELS;
const HISTORY_DIR = join(__dirname, ".bot-history");
const CHECKPOINT_FILE = join(HISTORY_DIR, ".checkpoints.json");

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

async function runClaude(prompt, channelId, reqLog, sendMessage) {
  // Fetch recent history from all channels to inject as context
  let recentContext = "";
  try {
    recentContext = await fetchRecentHistory();
    if (recentContext) {
      reqLog.info({ chars: recentContext.length }, "Loaded recent channel history");
    }
  } catch (err) {
    reqLog.warn({ err: err.message }, "Failed to load recent history, proceeding without");
  }

  return new Promise((resolve, reject) => {
    const session = sessions.get(channelId);

    const basePrompt = process.env.BOT_SYSTEM_PROMPT ||
      "You are running inside a Discord bot. Keep responses concise — Discord has a 2000 char limit per message. Do NOT perform startup rituals. Be brief.";

    const systemPrompt = recentContext
      ? `${basePrompt}\n\n${recentContext}`
      : basePrompt;

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

// --- Recent context loader (last N hours across all channels) ---
// Discord snowflake: (timestamp_ms - DISCORD_EPOCH) << 22
const DISCORD_EPOCH = 1420070400000n;

function timestampToSnowflake(timestampMs) {
  return String((BigInt(timestampMs) - DISCORD_EPOCH) << 22n);
}

async function fetchRecentHistory() {
  if (RECENT_CONTEXT_CHANNELS.length === 0) return "";

  const cutoffMs = Date.now() - RECENT_CONTEXT_HOURS * 3600000;
  const afterSnowflake = timestampToSnowflake(cutoffMs);
  const allMessages = [];

  for (const channelId of RECENT_CONTEXT_CHANNELS) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) continue;

      const channelName = channel.name || `dm-${channelId}`;
      let lastId = afterSnowflake;

      while (true) {
        const batch = await channel.messages.fetch({ limit: 100, after: lastId });
        if (batch.size === 0) break;

        const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        for (const m of sorted) {
          allMessages.push({
            timestamp: m.createdAt.toISOString(),
            ts: m.createdTimestamp,
            channel: channelName,
            author: m.author.tag || m.author.username,
            isBot: m.author.bot,
            content: m.content.substring(0, 1500),
          });
        }
        lastId = sorted[sorted.length - 1].id;

        if (batch.size < 100) break;
        if (allMessages.length > 500) break; // safety cap
      }
    } catch (err) {
      log.warn({ channelId, err: err.message }, "Failed to fetch recent history for channel");
    }
  }

  if (allMessages.length === 0) return "";

  // Sort chronologically across all channels
  allMessages.sort((a, b) => a.ts - b.ts);

  const lines = allMessages.map((m) => {
    const time = m.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z");
    const botTag = m.isBot ? " (bot)" : "";
    return `[${time}] #${m.channel} | ${m.author}${botTag}: ${m.content}`;
  });

  return [
    `--- Recent conversation history (last ${RECENT_CONTEXT_HOURS}h, ${allMessages.length} messages) ---`,
    ...lines,
    "--- End recent history ---",
  ].join("\n");
}

// --- Background summarizer (opt-in via SUMMARIZE_INTERVAL_MS) ---
function loadCheckpoints() {
  try {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCheckpoints(checkpoints) {
  mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoints, null, 2));
}

async function fetchMessagesSince(channel, afterId) {
  const allMessages = [];
  let lastId = afterId;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.after = lastId;

    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;

    const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    allMessages.push(...sorted);
    lastId = sorted[sorted.length - 1].id;

    if (allMessages.length >= SUMMARIZE_BATCH_SIZE) break;
    if (batch.size < 100) break;
  }

  return allMessages;
}

function groupByDate(messages) {
  const groups = {};
  for (const m of messages) {
    const date = m.createdAt.toISOString().split("T")[0];
    if (!groups[date]) groups[date] = [];
    groups[date].push({
      timestamp: m.createdAt.toISOString(),
      author: m.author.tag,
      content: m.content.substring(0, 2000),
      isBot: m.author.bot,
    });
  }
  return groups;
}

function summarizeWithClaude(channelName, date, messages) {
  return new Promise((resolve, reject) => {
    const transcript = messages
      .map((m) => `[${m.timestamp}] ${m.isBot ? "(bot) " : ""}${m.author}: ${m.content}`)
      .join("\n");

    const prompt = [
      `Summarize this Discord conversation from #${channelName} on ${date}.`,
      "",
      "Create a structured summary with:",
      "- **Topics discussed** — what subjects came up",
      "- **Decisions made** — any conclusions or agreements",
      "- **Action items** — tasks assigned or next steps identified",
      "- **Key context** — important facts, debugging results, or technical details worth remembering",
      "",
      "Be thorough but concise. Preserve specific details like error messages, file paths, issue numbers, and names.",
      "Do NOT add commentary — just summarize what happened.",
      "",
      "```",
      transcript,
      "```",
    ].join("\n");

    const args = [
      "--output-format", "stream-json",
      "--verbose",
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
      "-p", prompt,
      "--append-system-prompt", "You are a summarization assistant. Output only the summary, no preamble. Keep it under 2000 characters.",
    ];

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_AGENT_SDK_VERSION;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
    delete cleanEnv.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING;

    const child = spawn(CLAUDE_BIN, args, {
      cwd: CLAUDE_CWD,
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });

    let buffer = "";
    let result = "";

    child.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text") result += block.text;
            }
          }
        } catch { /* skip */ }
      }
    });

    child.on("close", (code) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text") result += block.text;
            }
          }
        } catch { /* ignore */ }
      }

      if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}`));
        return;
      }
      resolve(result.trim());
    });

    child.on("error", (err) => reject(err));
  });
}

function writeSummary(channelName, date, messageCount, summary) {
  mkdirSync(HISTORY_DIR, { recursive: true });
  const filename = `${date}-${channelName}.md`;
  const filepath = join(HISTORY_DIR, filename);
  const content = [
    `# ${channelName} — ${date}`,
    "",
    `> ${messageCount} messages summarized`,
    "",
    summary,
    "",
  ].join("\n");
  writeFileSync(filepath, content);
  return filepath;
}

let summarizing = false;

async function runSummarizer() {
  if (summarizing) return;
  if (SUMMARIZE_CHANNELS.length === 0) return;
  summarizing = true;

  const sumLog = log.child({ component: "summarizer" });
  sumLog.info({ channels: SUMMARIZE_CHANNELS.length }, "Summarizer cycle starting");

  const checkpoints = loadCheckpoints();
  let totalMessages = 0;
  let totalSummaries = 0;

  for (const channelId of SUMMARIZE_CHANNELS) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) continue;

      const channelName = (channel.name || `dm-${channelId}`).replace(/[^a-zA-Z0-9-_]/g, "-");
      const afterId = checkpoints[channelId] || null;

      const messages = await fetchMessagesSince(channel, afterId);
      if (messages.length === 0) continue;

      totalMessages += messages.length;
      const groups = groupByDate(messages);

      for (const date of Object.keys(groups).sort()) {
        const dayMessages = groups[date];
        try {
          const summary = await summarizeWithClaude(channelName, date, dayMessages);
          writeSummary(channelName, date, dayMessages.length, summary);
          totalSummaries++;
          sumLog.info({ channel: channelName, date, messages: dayMessages.length }, "Summary saved");
        } catch (err) {
          sumLog.error({ channel: channelName, date, err: err.message }, "Failed to summarize");
        }
      }

      checkpoints[channelId] = messages[messages.length - 1].id;
      saveCheckpoints(checkpoints);
    } catch (err) {
      sumLog.error({ channelId, err: err.message }, "Failed to process channel");
    }
  }

  sumLog.info({ totalMessages, totalSummaries }, "Summarizer cycle complete");
  summarizing = false;
}

if (SUMMARIZE_INTERVAL_MS > 0) {
  // Run first cycle shortly after bot connects (give Discord client time to be ready)
  setTimeout(() => {
    runSummarizer();
    setInterval(runSummarizer, SUMMARIZE_INTERVAL_MS);
  }, 10000);
  log.info({ intervalMs: SUMMARIZE_INTERVAL_MS, channels: SUMMARIZE_CHANNELS }, "Background summarizer enabled");
}

// Graceful shutdown
process.on("SIGINT", () => {
  log.info("Shutting down...");
  client.destroy();
  process.exit(0);
});

client.login(DISCORD_TOKEN);
