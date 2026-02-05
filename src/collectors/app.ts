import * as fs from "fs";
import * as path from "path";
import type { AppMetrics, ServerLockInfo, LogMetrics, VuosProcessInfo } from "../types";
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
let cachedVuosProcess: VuosProcessInfo | null = null;
let lastCpuTimeMs = 0;
let lastCpuTimestamp = 0;

// --- Crash detection ---
let cachedCrashCount = 0;
let lastKnownPid: number | null = null;
let crashCountDate: string = new Date().toDateString();

interface ProcessResult {
  running: boolean;
  pid: number | null;
  memoryMB: number | null;
  processInfo: VuosProcessInfo | null;
}

const VUOS_INFO_SCRIPT = `$p = Get-Process -Name 'Vu One' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p) {
  $cpuTime = $p.TotalProcessorTime.TotalMilliseconds
  $gpuMemMB = -1
  try {
    $samples = (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples
    $match = $samples | Where-Object { $_.InstanceName -match ('pid_' + $p.Id + '_') } | Select-Object -First 1
    if ($match) { $gpuMemMB = [math]::Round($match.CookedValue / 1MB, 0) }
  } catch {}
  $startTime = $p.StartTime.ToString('o')
  Write-Output "$($p.Id)|$($p.WorkingSet64)|$($p.Responding)|$($p.Threads.Count)|$($p.HandleCount)|$($p.PriorityClass)|$startTime|$cpuTime|$gpuMemMB"
} else { Write-Output "none" }`;

async function getVuosProcessInfo(): Promise<ProcessResult> {
  try {
    const proc = Bun.spawn(["powershell", "-NoProfile", "-Command", VUOS_INFO_SCRIPT]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const trimmed = output.trim();
    if (trimmed === "none" || !trimmed) {
      return { running: false, pid: null, memoryMB: null, processInfo: null };
    }

    const parts = trimmed.split("|");
    const pid = parseInt(parts[0], 10);
    const memBytes = parseInt(parts[1], 10);
    const responding = parts[2] === "True";
    const threads = parseInt(parts[3], 10);
    const handles = parseInt(parts[4], 10);
    const priority = parts[5] || "Normal";
    const startTime = parts[6] || null;
    const cpuTimeMs = parseFloat(parts[7]) || 0;
    const gpuMemMB = parseInt(parts[8], 10);

    return {
      running: true,
      pid: isNaN(pid) ? null : pid,
      memoryMB: isNaN(memBytes) ? null : Math.round(memBytes / (1024 * 1024)),
      processInfo: {
        responding,
        threads: isNaN(threads) ? 0 : threads,
        handles: isNaN(handles) ? 0 : handles,
        priority,
        startTime,
        cpuTimeMs,
        gpuMemoryMB: gpuMemMB >= 0 ? gpuMemMB : null,
      },
    };
  } catch {
    return { running: false, pid: null, memoryMB: null, processInfo: null };
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

const ERROR_WINDOW_MS = 60 * 60 * 1000; // Only count errors from the last hour

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

    // Filter to errors within the last hour
    const cutoff = Date.now() - ERROR_WINDOW_MS;
    const recentLines = errorLines.filter((l) => {
      const match = l.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/);
      if (!match) return false;
      const ts = new Date(match[1].replace(" ", "T")).getTime();
      return !isNaN(ts) && ts >= cutoff;
    });

    let lastError: string | null = null;
    let lastErrorTime: string | null = null;
    if (recentLines.length > 0) {
      const last = recentLines[recentLines.length - 1];
      const match = last.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\d.]*Z?)\s*(.*)/);
      if (match) {
        lastErrorTime = match[1];
        lastError = match[2].replace(/^\[error\]\s*/, "").trim().substring(0, 200);
      } else {
        lastError = last.substring(0, 200);
      }
    }

    return { recentErrorCount: recentLines.length, lastError, lastErrorTime };
  } catch {
    return { recentErrorCount: 0, lastError: null, lastErrorTime: null };
  }
}

async function refreshProcesses() {
  // Get Vu One info (PID + memory + extended) in a single call
  const vuosInfo = await getVuosProcessInfo();
  cachedVuosRunning = vuosInfo.running;
  cachedVuosMemoryMB = vuosInfo.memoryMB;
  cachedVuosProcess = vuosInfo.processInfo;

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
    vuosProcess: cachedVuosProcess,
    crashCountToday: cachedCrashCount,
    serverLock: readServerLock(),
    logs: cachedLogs,
  };
}
