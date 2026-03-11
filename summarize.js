#!/usr/bin/env node

/**
 * Discord Chat History Summarizer
 *
 * Background script that fetches Discord messages since the last run,
 * summarizes them with Claude, and stores daily summaries on disk.
 * These summaries are searched by the bot's /remember command.
 *
 * Usage:
 *   node summarize.js                  # summarize all tracked channels
 *   node summarize.js --dry-run        # fetch and show what would be summarized
 *
 * Run on a schedule (cron, pm2, systemd timer) — e.g., daily at midnight.
 */

require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { spawn } = require("child_process");
const { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } = require("fs");
const { join } = require("path");

// --- Config ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_CWD = process.env.CLAUDE_CWD || process.cwd();
const HISTORY_DIR = join(__dirname, ".bot-history");
const CHECKPOINT_FILE = join(HISTORY_DIR, ".checkpoints.json");
const SUMMARIZE_CHANNELS = process.env.SUMMARIZE_CHANNELS
  ? process.env.SUMMARIZE_CHANNELS.split(",").filter(Boolean)
  : (process.env.MONITOR_CHANNELS || "").split(",").filter(Boolean);
const SUMMARIZE_BATCH_SIZE = parseInt(process.env.SUMMARIZE_BATCH_SIZE, 10) || 200;
const DRY_RUN = process.argv.includes("--dry-run");

if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is required");
  process.exit(1);
}

if (SUMMARIZE_CHANNELS.length === 0) {
  console.error("No channels to summarize. Set SUMMARIZE_CHANNELS or MONITOR_CHANNELS in .env");
  process.exit(1);
}

// --- Checkpoint tracking ---
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

// --- Discord message fetching ---
// Fetches all messages after a given snowflake ID, paginating as needed
async function fetchMessagesSince(channel, afterId) {
  const allMessages = [];
  let lastId = afterId;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.after = lastId;

    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;

    // batch is sorted newest-first by Discord API
    const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    allMessages.push(...sorted);
    lastId = sorted[sorted.length - 1].id;

    // Safety limit
    if (allMessages.length >= SUMMARIZE_BATCH_SIZE) {
      console.log(`  Hit batch size limit (${SUMMARIZE_BATCH_SIZE}), stopping fetch`);
      break;
    }

    // If we got less than 100, we've reached the end
    if (batch.size < 100) break;
  }

  return allMessages;
}

// --- Group messages by date ---
function groupByDate(messages) {
  const groups = {};
  for (const msg of messages) {
    const date = msg.createdAt.toISOString().split("T")[0]; // YYYY-MM-DD
    if (!groups[date]) groups[date] = [];
    groups[date].push({
      timestamp: msg.createdAt.toISOString(),
      author: msg.author.tag,
      content: msg.content.substring(0, 2000),
      isBot: msg.author.bot,
    });
  }
  return groups;
}

// --- Claude summarization ---
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
      timeout: 120000, // 2 min per summary
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
        } catch {
          // skip non-JSON
        }
      }
    });

    child.on("close", (code) => {
      // Process remaining buffer
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

// --- Write summary to disk ---
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

// --- Main ---
async function main() {
  console.log("Discord Chat History Summarizer");
  console.log(`Channels: ${SUMMARIZE_CHANNELS.join(", ")}`);
  console.log(`History dir: ${HISTORY_DIR}`);
  if (DRY_RUN) console.log("DRY RUN — no summaries will be written\n");

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  await client.login(DISCORD_TOKEN);
  console.log(`Logged in as ${client.user.tag}\n`);

  const checkpoints = loadCheckpoints();
  let totalMessages = 0;
  let totalSummaries = 0;

  for (const channelId of SUMMARIZE_CHANNELS) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        console.log(`Skipping ${channelId} — not a text channel`);
        continue;
      }

      const channelName = (channel.name || `dm-${channelId}`).replace(/[^a-zA-Z0-9-_]/g, "-");
      const afterId = checkpoints[channelId] || null;

      console.log(`#${channelName} (${channelId})`);
      console.log(`  Checkpoint: ${afterId || "(none — first run)"}`);

      const messages = await fetchMessagesSince(channel, afterId);
      console.log(`  Fetched: ${messages.length} new messages`);

      if (messages.length === 0) {
        console.log(`  Nothing to summarize\n`);
        continue;
      }

      totalMessages += messages.length;
      const groups = groupByDate(messages);
      const dates = Object.keys(groups).sort();

      for (const date of dates) {
        const dayMessages = groups[date];
        console.log(`  ${date}: ${dayMessages.length} messages`);

        if (DRY_RUN) {
          console.log(`    Would summarize ${dayMessages.length} messages`);
          continue;
        }

        const summary = await summarizeWithClaude(channelName, date, dayMessages);
        const filepath = writeSummary(channelName, date, dayMessages.length, summary);
        console.log(`    Saved: ${filepath}`);
        totalSummaries++;
      }

      // Update checkpoint to the last message we processed
      const lastMessage = messages[messages.length - 1];
      checkpoints[channelId] = lastMessage.id;

      if (!DRY_RUN) {
        saveCheckpoints(checkpoints);
      }

      console.log(`  Checkpoint updated: ${lastMessage.id}\n`);
    } catch (err) {
      console.error(`Error processing ${channelId}: ${err.message}`);
    }
  }

  console.log(`\nDone. ${totalMessages} messages → ${totalSummaries} summaries`);
  client.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
