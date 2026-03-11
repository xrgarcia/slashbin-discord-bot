#!/usr/bin/env node
import { spawn, execSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PID_FILE = join(__dirname, ".bot.pid");
const LOG_FILE = join(__dirname, "bot.log");
const BOT_SCRIPT = join(__dirname, "bot.js");

const command = process.argv[2];
const isWindows = process.platform === "win32";

function readPid() {
  try {
    return parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  } catch {
    return null;
  }
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    if (isWindows) {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: "utf8" });
      return out.includes(String(pid));
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanPid() {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

function start() {
  const pid = readPid();
  if (isRunning(pid)) {
    console.log(`Bot is already running (PID ${pid})`);
    process.exit(1);
  }
  cleanPid();

  const logFd = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [BOT_SCRIPT], {
    cwd: __dirname,
    stdio: ["ignore", logFd, logFd],
    detached: !isWindows,
    env: process.env,
  });

  writeFileSync(PID_FILE, String(child.pid));

  if (!isWindows) child.unref();

  // Wait briefly and confirm the process is still alive
  setTimeout(() => {
    if (isRunning(child.pid)) {
      console.log(`Bot started (PID ${child.pid})`);
      console.log(`Logs: ${LOG_FILE}`);
    } else {
      console.error("Bot failed to start. Check bot.log for details.");
      cleanPid();
      process.exit(1);
    }
    process.exit(0);
  }, 2000);
}

function stop() {
  const pid = readPid();
  if (!isRunning(pid)) {
    console.log("Bot is not running");
    cleanPid();
    return;
  }

  console.log(`Stopping bot (PID ${pid})...`);
  try {
    if (isWindows) {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGINT");
    }
  } catch (err) {
    console.error(`Failed to stop: ${err.message}`);
    process.exit(1);
  }

  // Wait for graceful shutdown (up to 5s)
  const deadline = Date.now() + 5000;
  const poll = setInterval(() => {
    if (!isRunning(pid) || Date.now() > deadline) {
      clearInterval(poll);
      if (isRunning(pid)) {
        console.log("Graceful shutdown timed out, force killing...");
        try {
          if (isWindows) {
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
          } else {
            process.kill(pid, "SIGKILL");
          }
        } catch { /* already dead */ }
      }
      cleanPid();
      console.log("Bot stopped");
    }
  }, 200);
}

function restart() {
  const pid = readPid();
  if (isRunning(pid)) {
    stop();
    // Wait for stop to complete before starting
    const deadline = Date.now() + 6000;
    const poll = setInterval(() => {
      if (!isRunning(pid) || Date.now() > deadline) {
        clearInterval(poll);
        start();
      }
    }, 200);
  } else {
    cleanPid();
    start();
  }
}

function status() {
  const pid = readPid();
  if (isRunning(pid)) {
    console.log(`Bot is running (PID ${pid})`);

    // Show uptime on Unix
    if (!isWindows) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const startTicks = parseInt(stat.split(" ")[21], 10);
        const uptime = readFileSync("/proc/uptime", "utf8");
        const systemUptime = parseFloat(uptime.split(" ")[0]);
        const clkTck = 100; // standard on Linux
        const processUptime = systemUptime - startTicks / clkTck;
        const hours = Math.floor(processUptime / 3600);
        const mins = Math.floor((processUptime % 3600) / 60);
        console.log(`Uptime: ${hours}h ${mins}m`);
      } catch {
        // /proc not available (macOS) — skip uptime
      }
    }

    // Show last 3 log lines
    try {
      const log = readFileSync(LOG_FILE, "utf8").trim().split("\n");
      const tail = log.slice(-3);
      console.log("\nRecent logs:");
      tail.forEach((l) => console.log(`  ${l}`));
    } catch { /* no log file */ }
  } else {
    console.log("Bot is not running");
    if (pid) {
      console.log(`(stale PID file referenced ${pid})`);
      cleanPid();
    }
  }
}

function logs() {
  const lines = parseInt(process.argv[3], 10) || 20;
  try {
    const log = readFileSync(LOG_FILE, "utf8").trim().split("\n");
    log.slice(-lines).forEach((l) => console.log(l));
  } catch {
    console.log("No log file found");
  }
}

switch (command) {
  case "start":
    start();
    break;
  case "stop":
    stop();
    break;
  case "restart":
    restart();
    break;
  case "status":
    status();
    break;
  case "logs":
    logs();
    break;
  default:
    console.log(`Usage: node bot-manager.mjs <command>

Commands:
  start     Start the bot in the background
  stop      Stop the running bot gracefully
  restart   Stop and start the bot
  status    Show whether the bot is running
  logs [N]  Show last N lines of bot.log (default: 20)`);
    process.exit(command ? 1 : 0);
}
