import * as fs from "fs";
import * as path from "path";
import type { AppMetrics, ServerLockInfo, LogMetrics } from "../types";

const VUOS_DIR = "C:\\Program Files (x86)\\Vu One OS\\Vu One_Data\\StreamingAssets\\Vu One";
const LOCK_FILE = path.join(VUOS_DIR, "vu-server.lock");
const ERROR_LOG = path.join(VUOS_DIR, "logs", "error.log");

const HEARTBEAT_STALE_MS = 10_000;

// --- Cached slow metrics ---
let cachedVuosRunning = false;
let cachedServerRunning = false;
let cachedServerVersion = "unknown";
let cachedLogs: LogMetrics = { recentErrorCount: 0, lastError: null, lastErrorTime: null };

async function isProcessRunning(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([
      "powershell",
      "-NoProfile",
      "-Command",
      `(Get-Process -Name '${name}' -ErrorAction SilentlyContinue) -ne $null`,
    ]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

function getServerVersion(): string {
  try {
    const pkgPath = path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      "vu-one-server",
      "package.json"
    );
    const raw = fs.readFileSync(pkgPath, "utf-8");
    return JSON.parse(raw).version || "unknown";
  } catch {
    return "unknown";
  }
}

function readServerLock(): ServerLockInfo {
  try {
    const raw = fs.readFileSync(LOCK_FILE, "utf-8");
    const lock = JSON.parse(raw);
    const now = Date.now();
    const heartbeatAgeMs = lock.lastHeartbeat ? now - lock.lastHeartbeat : null;
    return {
      pid: lock.pid ?? null,
      startTime: lock.startTime ?? null,
      lastHeartbeat: lock.lastHeartbeat ?? null,
      heartbeatAgeMs,
      healthy: heartbeatAgeMs !== null && heartbeatAgeMs < HEARTBEAT_STALE_MS,
    };
  } catch {
    return {
      pid: null,
      startTime: null,
      lastHeartbeat: null,
      heartbeatAgeMs: null,
      healthy: false,
    };
  }
}

function readRecentErrors(): LogMetrics {
  try {
    const stat = fs.statSync(ERROR_LOG);
    const size = stat.size;
    const readSize = Math.min(size, 8192);
    const fd = fs.openSync(ERROR_LOG, "r");
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    fs.closeSync(fd);

    const text = buf.toString("utf-8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const errorLines = lines.filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l.trim()));

    let lastError: string | null = null;
    let lastErrorTime: string | null = null;
    if (errorLines.length > 0) {
      const last = errorLines[errorLines.length - 1];
      const match = last.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\d.]*Z?)\s*(.*)/);
      if (match) {
        lastErrorTime = match[1];
        lastError = match[2].replace(/^\[error\]\s*/, "").trim().substring(0, 200);
      } else {
        lastError = last.substring(0, 200);
      }
    }

    return { recentErrorCount: errorLines.length, lastError, lastErrorTime };
  } catch {
    return { recentErrorCount: 0, lastError: null, lastErrorTime: null };
  }
}

async function refreshProcesses() {
  const [vuos, server] = await Promise.all([
    isProcessRunning("Vu One"),
    isProcessRunning("Vu_OS_Server*"),
  ]);
  cachedVuosRunning = vuos;
  cachedServerRunning = server;
}

function refreshVersion() {
  cachedServerVersion = getServerVersion();
}

function refreshLogs() {
  cachedLogs = readRecentErrors();
}

/** Start background polling for slow app collectors */
export function startAppPolling() {
  // Process checks: every 5s
  refreshProcesses();
  setInterval(refreshProcesses, 5_000);

  // Server version: every 60s
  refreshVersion();
  setInterval(refreshVersion, 60_000);

  // Error log: every 10s
  refreshLogs();
  setInterval(refreshLogs, 10_000);
}

/** Fast snapshot — lock file is instant (fs read), rest from cache */
export function collectApp(): AppMetrics {
  return {
    vuosProcessRunning: cachedVuosRunning,
    serverProcessRunning: cachedServerRunning,
    serverVersion: cachedServerVersion,
    serverLock: readServerLock(),
    logs: cachedLogs,
  };
}
