import * as fs from "fs";
import * as path from "path";
import type { AppMetrics, ServerLockInfo, LogMetrics } from "../types";
import { VUOS_DIR } from "../config";

const LOCK_FILE = path.join(VUOS_DIR, "vu-server.lock");
const ERROR_LOG = path.join(VUOS_DIR, "logs", "error.log");

const HEARTBEAT_STALE_MS = 10_000;

// --- Cached slow metrics ---
let cachedVuosRunning = false;
let cachedServerRunning = false;
let cachedServerVersion = "unknown";
let cachedLogs: LogMetrics = { recentErrorCount: 0, lastError: null, lastErrorTime: null };
let cachedVuosMemoryMB: number | null = null;

// --- Crash detection ---
let cachedCrashCount = 0;
let lastKnownPid: number | null = null;
let crashCountDate: string = new Date().toDateString();

async function getProcessInfo(name: string): Promise<{ running: boolean; pid: number | null; memoryMB: number | null }> {
  try {
    const proc = Bun.spawn([
      "powershell",
      "-NoProfile",
      "-Command",
      `$p = Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { Write-Output "$($p.Id)|$($p.WorkingSet64)" } else { Write-Output "none" }`,
    ]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const trimmed = output.trim();
    if (trimmed === "none" || !trimmed) {
      return { running: false, pid: null, memoryMB: null };
    }

    const parts = trimmed.split("|");
    const pid = parseInt(parts[0], 10);
    const memBytes = parseInt(parts[1], 10);
    return {
      running: true,
      pid: isNaN(pid) ? null : pid,
      memoryMB: isNaN(memBytes) ? null : Math.round(memBytes / (1024 * 1024)),
    };
  } catch {
    return { running: false, pid: null, memoryMB: null };
  }
}

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
  // Get Vu One info (PID + memory) in a single call
  const vuosInfo = await getProcessInfo("Vu One");
  cachedVuosRunning = vuosInfo.running;
  cachedVuosMemoryMB = vuosInfo.memoryMB;

  // Crash detection: PID changed while process is running
  const today = new Date().toDateString();
  if (today !== crashCountDate) {
    cachedCrashCount = 0;
    crashCountDate = today;
  }

  if (vuosInfo.running && vuosInfo.pid !== null) {
    if (lastKnownPid !== null && vuosInfo.pid !== lastKnownPid) {
      cachedCrashCount++;
      console.log(`[app] Vu One OS crash detected (PID changed: ${lastKnownPid} → ${vuosInfo.pid}), count today: ${cachedCrashCount}`);
    }
    lastKnownPid = vuosInfo.pid;
  } else if (!vuosInfo.running) {
    // Process is down — don't reset lastKnownPid so we detect the restart
  }

  // Server check (separate because of wildcard name)
  cachedServerRunning = await isProcessRunning("Vu_OS_Server*");
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
    vuosMemoryMB: cachedVuosMemoryMB,
    crashCountToday: cachedCrashCount,
    serverLock: readServerLock(),
    logs: cachedLogs,
  };
}
