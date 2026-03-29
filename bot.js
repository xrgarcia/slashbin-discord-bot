require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");
const { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, statSync, appendFileSync, readdirSync } = require("fs");
const { join } = require("path");
const { pipeline } = require("stream/promises");
const { createWriteStream } = require("fs");
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
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || 3600000;
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
const SUMMARIZE_INTERVAL_MS = parseInt(process.env.SUMMARIZE_INTERVAL_MS, 10) || 0;
const SUMMARIZE_CHANNELS = process.env.SUMMARIZE_CHANNELS
  ? process.env.SUMMARIZE_CHANNELS.split(",").filter(Boolean)
  : MONITOR_CHANNELS;
const SUMMARIZE_BATCH_SIZE = parseInt(process.env.SUMMARIZE_BATCH_SIZE, 10) || 200;
const SUMMARY_LOOKBACK_HOURS = parseInt(process.env.SUMMARY_LOOKBACK_HOURS, 10) || 48;
const HISTORY_DIR = process.env.BOT_HISTORY_DIR
  ? (process.env.BOT_HISTORY_DIR.startsWith("/") ? process.env.BOT_HISTORY_DIR : join(__dirname, process.env.BOT_HISTORY_DIR))
  : join(__dirname, ".bot-history");
const CHECKPOINT_FILE = join(HISTORY_DIR, ".checkpoints.json");

// --- Bot identity (must be before buffer/PID config) ---
const BOT_NAME = process.env.BOT_NAME || "bot";

// --- Conversation buffer config ---
const BUFFER_FILE = join(__dirname, `.${BOT_NAME}-conversation-buffer.txt`);
const BUFFER_MAX_BYTES = parseInt(process.env.BUFFER_MAX_BYTES, 10) || 32 * 1024;
const BUFFER_TRUNCATE_RESPONSE = parseInt(process.env.BUFFER_TRUNCATE_RESPONSE, 10) || 500;
const ATTACHMENTS_DIR = process.env.BOT_ATTACHMENTS_DIR
  ? (process.env.BOT_ATTACHMENTS_DIR.startsWith("/") ? process.env.BOT_ATTACHMENTS_DIR : join(__dirname, process.env.BOT_ATTACHMENTS_DIR))
  : join(HISTORY_DIR, "attachments");

if (!DISCORD_TOKEN) {
  log.fatal("DISCORD_TOKEN environment variable is required");
  process.exit(1);
}

// --- Duplicate instance guard ---
// Prevent multiple bot instances from connecting to Discord simultaneously.
// Checks .bot.pid — if another bot.js process is already running, exit.
const PID_FILE = join(__dirname, `.${BOT_NAME}.pid`);
(() => {
  try {
    const existingPid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0); // throws if process doesn't exist
        // Verify it's actually a bot.js process
        try {
          const cmdline = readFileSync(`/proc/${existingPid}/cmdline`, "utf8");
          if (cmdline.includes("bot.js")) {
            log.fatal({ existingPid }, "Another bot instance is already running. Exiting.");
            process.exit(1);
          }
        } catch {
          // /proc not available — trust the PID check
          log.fatal({ existingPid }, "Another bot instance is already running. Exiting.");
          process.exit(1);
        }
      } catch {
        // Process doesn't exist — stale PID file, safe to continue
      }
    }
  } catch {
    // No PID file — safe to continue
  }
  writeFileSync(PID_FILE, String(process.pid));
})();

// Ensure directories exist
mkdirSync(HISTORY_DIR, { recursive: true });
mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// --- WebSocket Bridge ---
const WS_PORT = parseInt(process.env.WS_PORT, 10) || 9800;
const connectedAgents = new Map(); // agentId → { ws, discordBotId, channels }

const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });
log.info({ port: WS_PORT }, "WebSocket bridge listening");

wss.on("connection", (ws) => {
  let agentId = null;
  let heartbeatMisses = 0;

  const heartbeat = setInterval(() => {
    if (heartbeatMisses >= 3) {
      log.warn({ agentId }, "Agent missed 3 heartbeats, disconnecting");
      ws.terminate();
      return;
    }
    heartbeatMisses++;
    try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* ignore */ }
  }, 30000);

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "pong") {
      heartbeatMisses = 0;
      return;
    }

    if (msg.type === "handshake") {
      agentId = msg.agentId;
      connectedAgents.set(agentId, {
        ws,
        discordBotId: msg.discordBotId,
        channels: msg.channels,
      });
      log.info({ agentId, channels: msg.channels }, "Agent connected");
      ws.send(JSON.stringify({
        type: "handshake_ack",
        success: true,
        connectedAgents: Array.from(connectedAgents.keys()),
      }));
      return;
    }

    if (!agentId) {
      ws.send(JSON.stringify({ type: "error", message: "Handshake required" }));
      return;
    }

    if (msg.type === "status") {
      const agent = connectedAgents.get(agentId);
      if (agent?.channels?.status) {
        const channel = client.channels.cache.get(agent.channels.status);
        if (channel) {
          const prefix = msg.level === "error" ? "**[ERROR]**" : msg.level === "warn" ? "**[WARN]**" : "";
          const text = prefix ? `${prefix} ${msg.text}` : msg.text;
          for (const chunk of splitMessage(text)) {
            try { await channel.send(chunk); } catch (err) {
              log.error({ err: err.message, agentId }, "Failed to send status to Discord");
            }
          }
        }
      }
      return;
    }

    if (msg.type === "response") {
      const channel = client.channels.cache.get(msg.channelId);
      if (channel) {
        for (const chunk of splitMessage(msg.text)) {
          try {
            if (msg.replyTo) {
              const original = await channel.messages.fetch(msg.replyTo).catch(() => null);
              if (original) { await original.reply(chunk); continue; }
            }
            await channel.send(chunk);
          } catch (err) {
            log.error({ err: err.message, agentId }, "Failed to send response to Discord");
          }
        }
      }
      return;
    }

    if (msg.type === "typing") {
      const channel = client.channels.cache.get(msg.channelId);
      if (channel) {
        try { await channel.sendTyping(); } catch { /* ignore */ }
      }
      return;
    }
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    if (agentId) {
      connectedAgents.delete(agentId);
      log.info({ agentId }, "Agent disconnected");
    }
  });

  ws.on("error", (err) => {
    log.error({ err: err.message, agentId }, "WebSocket error");
  });
});

/**
 * Route a Discord message to connected agents.
 * Returns true if at least one agent received it.
 */
function routeToAgents(discordMsg, prompt) {
  let routed = false;
  for (const [id, agent] of connectedAgents) {
    const listenChannels = agent.channels?.listen || [];
    if (listenChannels.includes(discordMsg.channel.id)) {
      const payload = {
        type: "command",
        channelId: discordMsg.channel.id,
        userId: discordMsg.author.id,
        username: discordMsg.author.username,
        text: prompt,
        messageId: discordMsg.id,
        attachments: discordMsg.attachments.map(a => ({
          filename: a.name,
          url: a.url,
          contentType: a.contentType,
        })),
      };
      try {
        agent.ws.send(JSON.stringify(payload));
        routed = true;
        log.info({ agentId: id, channel: discordMsg.channel.id }, "Message routed to agent");
      } catch (err) {
        log.error({ err: err.message, agentId: id }, "Failed to route message to agent");
      }
    }
  }
  return routed;
}

// --- Conversation buffer ---

function formatBufferLine(channelName, author, text, fileRefs) {
  const now = new Date();
  const ts = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  let line = `[${ts} #${channelName}] ${author}: ${text}`;
  if (fileRefs && fileRefs.length > 0) {
    const refs = fileRefs.map(f => `[file: ${f.name} ${Math.round(f.size / 1024)}KB ${f.path}]`).join(" ");
    line += ` ${refs}`;
  }
  return line;
}

function appendToBuffer(line) {
  appendFileSync(BUFFER_FILE, line + "\n");
}

function readBuffer() {
  try {
    return readFileSync(BUFFER_FILE, "utf8");
  } catch {
    return "";
  }
}

function getBufferSize() {
  try {
    return statSync(BUFFER_FILE).size;
  } catch {
    return 0;
  }
}

let rotating = false;

async function rotateBuffer() {
  if (rotating) return;
  if (getBufferSize() <= BUFFER_MAX_BYTES) return;
  rotating = true;

  try {
    const content = readBuffer();
    const lines = content.split("\n").filter(Boolean);
    // Keep the newest 60%, summarize the oldest 40%
    const cutIndex = Math.floor(lines.length * 0.4);
    const oldLines = lines.slice(0, cutIndex);
    const keepLines = lines.slice(cutIndex);

    if (oldLines.length > 0) {
      // Summarize the old lines
      const rotLog = log.child({ component: "buffer-rotation" });
      rotLog.info({ oldLines: oldLines.length, keepLines: keepLines.length }, "Rotating buffer");

      try {
        const summary = await summarizeBufferLines(oldLines);
        const date = new Date().toISOString().split("T")[0];
        writeSummary("buffer-rotation", date, oldLines.length, summary);
        rotLog.info({ date, lines: oldLines.length }, "Rotation summary saved");
      } catch (err) {
        rotLog.warn({ err: err.message }, "Failed to summarize during rotation, trimming anyway");
      }

      // Clean up orphaned attachments
      const keepContent = keepLines.join("\n");
      cleanOrphanedAttachments(keepContent);
    }

    // Write back only the kept lines
    writeFileSync(BUFFER_FILE, keepLines.join("\n") + "\n");
  } finally {
    rotating = false;
  }
}

function cleanOrphanedAttachments(bufferContent) {
  try {
    const files = readdirSync(ATTACHMENTS_DIR);
    for (const file of files) {
      const filePath = join(ATTACHMENTS_DIR, file);
      if (!bufferContent.includes(filePath)) {
        try {
          unlinkSync(filePath);
          log.debug({ file }, "Cleaned orphaned attachment");
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore if dir doesn't exist */ }
}

async function recordMessage(msg) {
  const channelName = msg.channel.name || "DM";
  const author = msg.author.username || msg.author.tag;
  let text = msg.content || "";

  // Download and record any attachments
  const fileRefs = [];
  for (const [, attachment] of msg.attachments) {
    try {
      const savedPath = await downloadAttachmentPersistent(attachment, msg.id);
      fileRefs.push({ name: attachment.name || "file", size: attachment.size || 0, path: savedPath });
    } catch (err) {
      log.debug({ name: attachment.name, err: err.message }, "Failed to download attachment for buffer");
    }
  }

  if (!text && fileRefs.length === 0) return fileRefs;

  const line = formatBufferLine(channelName, author, text, fileRefs);
  appendToBuffer(line);

  // Check if rotation needed (async, don't block)
  if (getBufferSize() > BUFFER_MAX_BYTES) {
    rotateBuffer().catch(err => log.warn({ err: err.message }, "Buffer rotation failed"));
  }

  return fileRefs;
}

function recordBotResponse(channelName, responseText) {
  if (!responseText || !responseText.trim()) return;

  let text = responseText.trim();
  if (text.length > BUFFER_TRUNCATE_RESPONSE) {
    const fullLength = text.length;
    text = `${text.substring(0, BUFFER_TRUNCATE_RESPONSE)}... [truncated, ${fullLength} chars total]`;
  }

  const botName = client.user ? (client.user.username || client.user.tag) : "Bot";
  const line = formatBufferLine(channelName, botName, text, null);
  appendToBuffer(line);
}

// --- Persistent attachment handling ---
const ATTACHMENT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".pdf", ".txt", ".json", ".csv"]);

function isDownloadableAttachment(attachment) {
  const name = (attachment.name || "").toLowerCase();
  const contentType = (attachment.contentType || "").toLowerCase();
  const ext = name.substring(name.lastIndexOf("."));
  return contentType.startsWith("image/") || ATTACHMENT_EXTENSIONS.has(ext);
}

function isImageAttachment(attachment) {
  const contentType = (attachment.contentType || "").toLowerCase();
  const name = (attachment.name || "").toLowerCase();
  return contentType.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].some(ext => name.endsWith(ext));
}

async function downloadAttachmentPersistent(attachment, messageId) {
  const { Readable } = require("stream");
  const filename = `${messageId}-${attachment.name || "file"}`;
  const savePath = join(ATTACHMENTS_DIR, filename);

  // Skip if already downloaded
  if (existsSync(savePath)) return savePath;

  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  const nodeStream = Readable.fromWeb(res.body);
  await pipeline(nodeStream, createWriteStream(savePath));
  return savePath;
}

// --- Active Claude process tracking ---
const activeProcesses = new Map();
const MAX_CONCURRENT_CLAUDE = parseInt(process.env.MAX_CONCURRENT_CLAUDE, 10) || 2;

// --- Bot-to-bot exchange tracking ---
const botExchanges = new Map();

// Prune stale botExchanges every 10 minutes
setInterval(() => {
  if (botExchanges.size > 0) {
    log.debug({ entries: botExchanges.size }, "Pruning botExchanges");
    botExchanges.clear();
  }
}, 600000);

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

// --- WebSocket crash resilience ---
client.on("error", (err) => {
  log.error({ err: err.message }, "Discord client error");
});

client.on("shardError", (err) => {
  log.error({ err: err.message }, "Discord WebSocket error");
});

client.once("ready", () => {
  log.info({ tag: client.user.tag, cwd: CLAUDE_CWD }, "Bot online");
  log.info(
    { allowedUsers: ALLOWED_USER_IDS.length || "all", monitoredChannels: MONITOR_CHANNELS },
    "Access config"
  );
});

client.on("messageCreate", async (msg) => {
  // Skip own messages (bot responses are recorded via recordBotResponse)
  if (msg.author.id === client.user?.id) return;

  // Record ALL messages to buffer before any response filtering
  let fileRefs = [];
  try {
    fileRefs = await recordMessage(msg);
  } catch (err) {
    log.debug({ err: err.message }, "Failed to record message to buffer");
  }

  // --- Stop command handling (before response filtering so it works in any channel) ---
  // Only humans can issue stop commands
  if (!msg.author.bot) {
    const rawContent = msg.content.trim();
    const stopPattern = /^(?:<@!?\d+>\s*)*(?:\/stop|stop)$/i;
    const isStopCommand = stopPattern.test(rawContent);

    if (isStopCommand) {
      const mentionsThisBot = msg.mentions.has(client.user);
      const mentionsAnyBot = rawContent.match(/<@!?\d+>/g);
      const isBroadcast = !mentionsAnyBot; // plain "stop" or "/stop" with no mentions
      const isTargeted = mentionsThisBot;   // "@ThisBot stop"

      if (isBroadcast || isTargeted) {
        const reqLog = log.child({ channel: msg.channel.id, user: msg.author.tag });
        const child = activeProcesses.get(msg.channel.id);
        if (child) {
          child.kill("SIGTERM");
          activeProcesses.delete(msg.channel.id);
          reqLog.info({ broadcast: isBroadcast }, "Claude process killed by stop");
          if (isTargeted) {
            await msg.reply("Stopped.");
          }
          // Broadcast stop: kill silently (all bots kill, none reply to avoid spam)
        }
        return;
      }
      // Stop mentions a different bot — ignore
      return;
    }
  }

  // --- Response filtering (only below this point) ---
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
    botExchanges.delete(msg.channel.id);
  }

  let prompt = msg.content
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .trim();

  const hasAttachments = fileRefs.length > 0;
  if (!prompt && !hasAttachments) return;
  if (!prompt && hasAttachments) prompt = "What do you see in this attachment?";

  const reqLog = log.child({ channel: msg.channel.id, user: msg.author.tag, prompt: prompt.substring(0, 80) });

  // --- Bridge routing: if a connected agent is listening on this channel, route to it ---
  if (routeToAgents(msg, prompt)) {
    reqLog.info("Message routed to connected agent via WebSocket");
    return;
  }

  if (prompt === "/status") {
    const bufSize = getBufferSize();
    const bufLines = readBuffer().split("\n").filter(Boolean).length;
    const running = activeProcesses.has(msg.channel.id);
    let attachCount = 0;
    try { attachCount = readdirSync(ATTACHMENTS_DIR).length; } catch { /* ignore */ }
    await msg.reply(`Buffer: ${Math.round(bufSize / 1024)}KB / ${Math.round(BUFFER_MAX_BYTES / 1024)}KB (${bufLines} messages, ${attachCount} attachments)${running ? " — **running**" : ""}`);
    return;
  }

  // Kill existing Claude process in this channel before spawning a new one
  const existingChild = activeProcesses.get(msg.channel.id);
  if (existingChild) {
    reqLog.info("Killing existing Claude process for new message");
    existingChild._intentionalKill = true;
    existingChild.kill("SIGTERM");
    activeProcesses.delete(msg.channel.id);
  }

  // Global concurrency guard — drop if too many Claude processes running
  if (activeProcesses.size >= MAX_CONCURRENT_CLAUDE) {
    reqLog.warn({ active: activeProcesses.size, max: MAX_CONCURRENT_CLAUDE }, "Claude concurrency limit reached, dropping message");
    await msg.reply("I'm busy with other requests — try again in a moment.");
    return;
  }

  const typing = setInterval(() => msg.channel.sendTyping(), 8000);
  msg.channel.sendTyping();

  const sendQueue = createSendQueue(msg, reqLog);
  const channelName = msg.channel.name || "DM";

  // Collect image paths from attachments for Claude prompt
  const imagePaths = fileRefs
    .filter(f => isImageAttachment({ name: f.name, contentType: "" }))
    .map(f => f.path);

  try {
    const responseText = await runClaude(prompt, msg.channel.id, reqLog, sendQueue.enqueue, imagePaths, channelName);
    clearInterval(typing);
    await sendQueue.flush();

    // Record bot's response to buffer
    recordBotResponse(channelName, responseText);
  } catch (err) {
    clearInterval(typing);
    await sendQueue.flush();
    // Don't send error to Discord for intentional kills — prevents bot-to-bot feedback loops
    if (err.message && err.message.includes("intentionally killed")) {
      reqLog.info({ err }, "Suppressed error from intentional kill");
    } else {
      reqLog.error({ err }, "Claude invocation failed");
      await msg.reply(`Error: ${err.message}`);
    }
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
      const item = pending.shift();
      // File attachment object — send directly
      if (typeof item === "object" && item.files) {
        try {
          await msg.reply(item);
        } catch (err) {
          reqLog.error({ err }, "Failed to send Discord file attachment");
        }
        continue;
      }
      const chunks = splitMessage(item);
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
    enqueue(item) {
      if (!item) return;
      if (typeof item === "string" && !item.trim()) return;
      pending.push(item);
      drain();
    },
    async flush() {
      while (pending.length > 0 || sending) {
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}

// --- Context building (buffer + summaries) ---

function loadRecentSummaries() {
  const cutoffMs = Date.now() - SUMMARY_LOOKBACK_HOURS * 3600000;
  const cutoffDate = new Date(cutoffMs).toISOString().split("T")[0];

  try {
    const files = readdirSync(HISTORY_DIR)
      .filter((f) => f.endsWith(".md") && !f.startsWith("."))
      .sort()
      .filter((f) => f >= cutoffDate);

    const summaries = [];
    for (const file of files) {
      try {
        const content = readFileSync(join(HISTORY_DIR, file), "utf8").trim();
        if (content) summaries.push(content);
      } catch { /* skip unreadable */ }
    }
    return summaries;
  } catch {
    return [];
  }
}

function buildContextPrompt() {
  const sections = [];

  // Layer 1: Recent summaries (compressed history beyond buffer window)
  const summaries = loadRecentSummaries();
  if (summaries.length > 0) {
    sections.push(
      "--- Conversation history (summaries from prior sessions) ---",
      ...summaries,
      "--- End summaries ---"
    );
  }

  // Layer 2: Conversation buffer (recent activity across all channels)
  const buffer = readBuffer();
  if (buffer.trim()) {
    sections.push(
      "--- Conversation buffer (recent activity across all channels) ---",
      buffer.trim(),
      "--- End conversation buffer ---"
    );
  }

  return sections.join("\n\n");
}

// --- Claude invocation (fresh session per message) ---

async function runClaude(prompt, channelId, reqLog, sendMessage, imagePaths = [], channelName = "unknown") {
  const context = buildContextPrompt();

  return new Promise((resolve, reject) => {
    const basePrompt = process.env.BOT_SYSTEM_PROMPT ||
      "You are running inside a Discord bot. Keep responses concise — Discord has a 2000 char limit per message. Do NOT perform startup rituals. Be brief.";

    const now = new Date();
    const timeContext = `\n\nCurrent time: ${now.toISOString()} (${now.toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "short", timeStyle: "long" })} CDT)`;

    const channelContext = `${timeContext}\n\nYou are responding in channel: #${channelName}. Only respond to the message in THIS channel. The conversation buffer contains messages from multiple channels — focus only on #${channelName} context. Do NOT respond to or act on messages from other channels.`;

    const systemPrompt = context
      ? `${basePrompt}${channelContext}\n\n${context}`
      : `${basePrompt}${channelContext}`;

    const args = [
      "--output-format", "stream-json",
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
      "--verbose",
      "--max-turns", "30",
      ...(process.env.CLAUDE_MODEL ? ["--model", process.env.CLAUDE_MODEL] : []),
      ...(process.env.MCP_CONFIG ? ["--mcp-config", process.env.MCP_CONFIG] : []),
      "--append-system-prompt", systemPrompt,
    ];

    // Build the final prompt with image/file paths prepended
    let finalPrompt = prompt;
    if (imagePaths.length > 0) {
      const imageRefs = imagePaths.map(p => `[Image attached by user — use the Read tool on "${p}" to view it]`).join("\n");
      finalPrompt = `${imageRefs}\n\n${prompt}`;
    }

    // Always fresh session — no --resume
    args.push("-p", finalPrompt);
    reqLog.info({ images: imagePaths.length }, "Starting fresh Claude session");

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

    activeProcesses.set(channelId, child);

    let jsonBuffer = "";
    let turnText = "";
    let fullResponse = ""; // Accumulate full response for buffer recording
    const writtenFiles = []; // Track files Claude creates for Discord attachment

    child.stdout.on("data", (data) => {
      jsonBuffer += data.toString();

      const lines = jsonBuffer.split("\n");
      jsonBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          handleStreamEvent(event, reqLog, sendMessage, {
            getTurnText: () => turnText,
            setTurnText: (t) => { turnText = t; },
            appendResponse: (t) => { fullResponse += t; },
            writtenFiles,
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
      activeProcesses.delete(channelId);
      const elapsed = Date.now() - startTime;

      if (jsonBuffer.trim()) {
        try {
          const event = JSON.parse(jsonBuffer);
          handleStreamEvent(event, reqLog, sendMessage, {
            getTurnText: () => turnText,
            setTurnText: (t) => { turnText = t; },
            appendResponse: (t) => { fullResponse += t; },
            writtenFiles,
          });
        } catch {
          // ignore
        }
      }

      // Send any remaining text from the last turn
      if (turnText.trim()) {
        sendMessage(turnText);
        fullResponse += turnText;
        turnText = "";
      }

      // Attach any files Claude created (CSV, PDF, etc.)
      // Also scan response text for file paths not caught by Write tool tracking
      // (e.g., files created via Bash/Python scripts)
      const FILE_EXTENSIONS = /\.(csv|pdf|xlsx|png|jpg)$/i;
      const pathMatches = fullResponse.match(/(?:^|[\s`'"])(\/?(?:[\w.-]+\/)*[\w.-]+\.\w{2,4})(?:[\s`'"]|$)/gm) || [];
      for (const match of pathMatches) {
        const cleaned = match.trim().replace(/^[`'"]+|[`'"]+$/g, "");
        if (!FILE_EXTENSIONS.test(cleaned)) continue;
        // Try multiple base directories — Claude may reference paths relative to
        // CLAUDE_CWD, its parent (repo root), or as absolute paths
        const candidates = cleaned.startsWith("/")
          ? [cleaned]
          : [join(CLAUDE_CWD, cleaned), join(CLAUDE_CWD, "..", cleaned), cleaned];
        for (const candidate of candidates) {
          if (existsSync(candidate) && !writtenFiles.includes(candidate)) {
            writtenFiles.push(candidate);
            break;
          }
        }
      }

      if (writtenFiles.length > 0) {
        const attachable = writtenFiles.filter(f => existsSync(f));
        if (attachable.length > 0) {
          sendMessage({ files: attachable.map(f => ({ attachment: f })) });
          reqLog.info({ files: attachable }, "Attaching files to Discord");
        }
      }

      if (code !== 0) {
        if (child._intentionalKill) {
          reqLog.info({ code, elapsed }, "Claude process intentionally killed");
          resolve(fullResponse);
          return;
        }
        reqLog.error({ code, elapsed }, "Claude exited with non-zero code");
        reject(new Error(`Claude exited with code ${code} after ${Math.round(elapsed / 1000)}s`));
        return;
      }

      reqLog.info({ elapsed }, "Claude completed");
      resolve(fullResponse);
    });

    child.on("error", (err) => {
      reqLog.error({ err }, "Failed to spawn Claude");
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

function handleStreamEvent(event, reqLog, sendMessage, state) {
  switch (event.type) {
    case "system":
      reqLog.info({ sessionId: event.session_id }, "Claude session started");
      break;

    case "assistant":
      if (event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text") {
            state.setTurnText(state.getTurnText() + block.text);
          } else if (block.type === "tool_use") {
            // Don't flush text on tool calls — wait until Claude is fully done.
            // Flushing here causes "multiple responses" where users see a preamble
            // ("Let me check...") as a separate message before the actual answer.
            // Track files Claude creates for Discord attachment
            // Only attach user-facing files (CSV, PDF, etc.), not config/internal files
            if (block.name === "Write" && block.input?.file_path) {
              const fp = block.input.file_path;
              if (/\.(csv|pdf|xlsx|png|jpg)$/i.test(fp)) {
                state.writtenFiles.push(fp);
              }
            }
            reqLog.info({ tool: block.name, inputPreview: JSON.stringify(block.input).substring(0, 120) }, "Tool call");
          }
        }
      }
      break;

    case "result":
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

// --- Buffer rotation summarizer ---

function summarizeBufferLines(lines) {
  return new Promise((resolve, reject) => {
    const transcript = lines.join("\n");

    const prompt = [
      "Summarize this conversation buffer that is being rotated out.",
      "",
      "Create a structured summary with:",
      "- **Topics discussed** — what subjects came up",
      "- **Decisions made** — any conclusions or agreements",
      "- **Action items** — tasks assigned or next steps identified",
      "- **Key context** — important facts, debugging results, or technical details worth remembering",
      "",
      "Be thorough but concise. Preserve specific details like error messages, file paths, issue numbers, and names.",
      "Note which channels and participants were involved.",
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

    let buf = "";
    let result = "";

    child.stdout.on("data", (data) => {
      buf += data.toString();
      const jsonLines = buf.split("\n");
      buf = jsonLines.pop();

      for (const line of jsonLines) {
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
      if (buf.trim()) {
        try {
          const event = JSON.parse(buf);
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

// --- Background summarizer (hourly channel summaries to HISTORY_DIR) ---

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

    let buf = "";
    let result = "";

    child.stdout.on("data", (data) => {
      buf += data.toString();
      const jsonLines = buf.split("\n");
      buf = jsonLines.pop();

      for (const line of jsonLines) {
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
      if (buf.trim()) {
        try {
          const event = JSON.parse(buf);
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
  setTimeout(() => {
    runSummarizer();
    setInterval(runSummarizer, SUMMARIZE_INTERVAL_MS);
  }, 10000);
  log.info({ intervalMs: SUMMARIZE_INTERVAL_MS, channels: SUMMARIZE_CHANNELS }, "Background summarizer enabled");
}

// --- Scheduled jobs ---
const SCHEDULES_FILE = join(HISTORY_DIR, "schedules.json");
const SCHEDULE_CHECK_MS = 60_000; // check every minute

function loadSchedules() {
  try {
    return JSON.parse(readFileSync(SCHEDULES_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveSchedules(schedules) {
  writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2) + "\n");
}

function cronMatchesTime(cron, date) {
  // Parse "M H D MO DOW" cron format — check if a given time matches
  const [cronMin, cronHour, cronDay, cronMonth, cronDow] = cron.split(/\s+/);
  const min = date.getMinutes(), hour = date.getHours();
  const day = date.getDate(), month = date.getMonth() + 1, dow = date.getDay();

  function matches(field, value) {
    if (field === "*") return true;
    return field.split(",").some(v => parseInt(v, 10) === value);
  }

  return matches(cronMin, min) && matches(cronHour, hour)
    && matches(cronDay, day) && matches(cronMonth, month)
    && matches(cronDow, dow);
}

function shouldRunNow(cron, lastRunKey) {
  // Check current minute AND the last few minutes (catch missed runs)
  const now = new Date();
  const LOOKBACK_MINUTES = 5;

  for (let i = 0; i <= LOOKBACK_MINUTES; i++) {
    const checkTime = new Date(now.getTime() - i * 60_000);
    const checkKey = `${checkTime.getFullYear()}-${checkTime.getMonth()}-${checkTime.getDate()}-${checkTime.getHours()}-${checkTime.getMinutes()}`;

    // Skip if already ran for this minute
    if (checkKey === lastRunKey) continue;

    if (cronMatchesTime(cron, checkTime)) return true;
  }

  return false;
}

async function runScheduledJobs() {
  const schedules = loadSchedules();
  if (!schedules.length) return;

  const now = new Date();
  let changed = false;

  for (const job of schedules) {
    // Check if job should run (current minute or missed in last 5 minutes)
    if (!shouldRunNow(job.cron, job._lastRun)) {
      // Only expire jobs that didn't need to run
      if (job.expires && new Date(job.expires) < now) {
        job._remove = true;
        changed = true;
        log.info({ id: job.id, expires: job.expires }, "Scheduled job expired, removing");
      }
      continue;
    }

    // Mark as run for this minute to prevent duplicates
    const nowKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    job._lastRun = nowKey;
    changed = true;

    const channel = client.channels.cache.get(job.channel);
    if (!channel) {
      log.warn({ id: job.id, channel: job.channel }, "Scheduled job channel not found");
      continue;
    }

    log.info({ id: job.id, prompt: job.prompt.substring(0, 80) }, "Running scheduled job");

    // Create a send function that posts to the channel directly
    const jobLog = log.child({ component: "scheduler", jobId: job.id });
    const sendToChannel = async (content) => {
      try {
        if (typeof content === "object" && content.files) {
          await channel.send(content);
        } else {
          for (const chunk of splitMessage(content)) {
            await channel.send(chunk);
          }
        }
      } catch (err) {
        jobLog.error({ err: err.message }, "Failed to send scheduled message");
      }
    };

    try {
      const channelName = channel.name || job.channel;
      await runClaude(job.prompt, job.channel, jobLog, sendToChannel, [], channelName);
    } catch (err) {
      jobLog.error({ err: err.message }, "Scheduled job failed");
      await sendToChannel(`Scheduled job "${job.id}" failed: ${err.message}`);
    }
  }

  if (changed) {
    saveSchedules(schedules.filter(j => !j._remove));
  }
}

// Start scheduler check loop
setInterval(runScheduledJobs, SCHEDULE_CHECK_MS);
log.info({ file: SCHEDULES_FILE }, "Job scheduler enabled");

// Graceful shutdown
process.on("SIGINT", () => {
  log.info("Shutting down...");
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log.info("Shutting down...");
  client.destroy();
  process.exit(0);
});

client.login(DISCORD_TOKEN);
