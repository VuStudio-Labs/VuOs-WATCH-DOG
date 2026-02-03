import * as os from "os";
import type { SystemMetrics, EventLogMetrics } from "../types";

// --- Cached slow metrics with background refresh ---

interface GpuInfo {
  name: string | null;
  usage: number | null;
  memUsedMB: number | null;
  memTotalMB: number | null;
  temp: number | null;
}

interface DiskInfo {
  totalMB: number;
  usedMB: number;
  percent: number;
}

interface DiskIO {
  readMBps: number;
  writeMBps: number;
}

let cachedCpu = 0;
let cachedGpu: GpuInfo = { name: null, usage: null, memUsedMB: null, memTotalMB: null, temp: null };
let cachedDisk: DiskInfo = { totalMB: 0, usedMB: 0, percent: 0 };
let cachedDiskIO: DiskIO = { readMBps: 0, writeMBps: 0 };
let cachedThermalThrottling = false;
let cachedPendingUpdates = 0;
let cachedEventLog: EventLogMetrics = { count: 0, lastMessage: null, lastTime: null };

// Continuous CPU sampling — keeps a rolling measurement without blocking
let prevCpuTimes: { idle: number; total: number } | null = null;

function sampleCpu() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }

  if (prevCpuTimes) {
    const dIdle = idle - prevCpuTimes.idle;
    const dTotal = total - prevCpuTimes.total;
    cachedCpu = dTotal === 0 ? 0 : Math.round((1 - dIdle / dTotal) * 1000) / 10;
  }

  prevCpuTimes = { idle, total };
}

// GPU detection strategy:
// 1. nvidia-smi  → full stats (NVIDIA)
// 2. PowerShell WMI fallback → name, VRAM, usage via perf counters (AMD/Intel/any)
// Once a strategy succeeds on first poll, it's locked in to avoid re-probing.

let gpuStrategy: "nvidia" | "wmi" | null = null;

async function refreshGpuNvidia(): Promise<boolean> {
  try {
    const proc = Bun.spawn([
      "nvidia-smi",
      "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
      "--format=csv,noheader,nounits",
    ]);
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0 || !output.trim()) return false;

    const parts = output.trim().split(",").map((s) => s.trim());
    cachedGpu = {
      name: parts[0] || null,
      usage: parts[1] ? parseInt(parts[1], 10) : null,
      memUsedMB: parts[2] ? parseInt(parts[2], 10) : null,
      memTotalMB: parts[3] ? parseInt(parts[3], 10) : null,
      temp: parts[4] ? parseInt(parts[4], 10) : null,
    };
    return true;
  } catch {
    return false;
  }
}

const WMI_GPU_SCRIPT = `
$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Status -eq 'OK' } | Select-Object -First 1
if (-not $gpu) { exit 1 }
$name = $gpu.Name
$vramMB = [math]::Round($gpu.AdapterRAM / 1MB)

# Try GPU usage via performance counters
$usage = $null
$temp = $null
try {
  $eng = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop |
    Where-Object { $_.Name -match 'engtype_3D' } |
    Measure-Object -Property UtilizationPercentage -Maximum
  if ($eng.Maximum) { $usage = [math]::Round($eng.Maximum) }
} catch {}

# Try temp via WMI thermal zone (works on some systems)
try {
  $thermal = Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace root/wmi -ErrorAction Stop |
    Select-Object -First 1
  if ($thermal) { $temp = [math]::Round(($thermal.CurrentTemperature - 2732) / 10) }
} catch {}

# Try dedicated GPU memory used via perf counters
$memUsed = $null
try {
  $mem = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction Stop |
    Select-Object -First 1
  if ($mem.DedicatedUsage) { $memUsed = [math]::Round($mem.DedicatedUsage / 1MB) }
} catch {}

Write-Output "$name|$vramMB|$usage|$memUsed|$temp"
`;

async function refreshGpuWmi(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["powershell", "-NoProfile", "-Command", WMI_GPU_SCRIPT]);
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0 || !output.trim()) return false;

    const parts = output.trim().split("|").map((s) => s.trim());
    cachedGpu = {
      name: parts[0] || null,
      memTotalMB: parts[1] && parts[1] !== "" ? parseInt(parts[1], 10) : null,
      usage: parts[2] && parts[2] !== "" ? parseInt(parts[2], 10) : null,
      memUsedMB: parts[3] && parts[3] !== "" ? parseInt(parts[3], 10) : null,
      temp: parts[4] && parts[4] !== "" ? parseInt(parts[4], 10) : null,
    };
    return true;
  } catch {
    return false;
  }
}

async function refreshGpu() {
  if (gpuStrategy === "nvidia") {
    await refreshGpuNvidia();
    return;
  }
  if (gpuStrategy === "wmi") {
    await refreshGpuWmi();
    return;
  }

  // First run: detect which strategy works
  if (await refreshGpuNvidia()) {
    gpuStrategy = "nvidia";
    return;
  }
  if (await refreshGpuWmi()) {
    gpuStrategy = "wmi";
    return;
  }
}

async function refreshDisk() {
  try {
    const proc = Bun.spawn([
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object Size,FreeSpace | ConvertTo-Json",
    ]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    let disks = JSON.parse(output);
    if (!Array.isArray(disks)) disks = [disks];

    let totalBytes = 0;
    let freeBytes = 0;
    for (const disk of disks) {
      totalBytes += disk.Size || 0;
      freeBytes += disk.FreeSpace || 0;
    }

    const totalMB = Math.round(totalBytes / (1024 * 1024));
    const usedMB = Math.round((totalBytes - freeBytes) / (1024 * 1024));
    cachedDisk = {
      totalMB,
      usedMB,
      percent: totalMB === 0 ? 0 : Math.round((usedMB / totalMB) * 1000) / 10,
    };
  } catch {}
}

async function refreshDiskIO() {
  try {
    const proc = Bun.spawn([
      "powershell",
      "-NoProfile",
      "-Command",
      `$c = Get-Counter '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec','\\PhysicalDisk(_Total)\\Disk Write Bytes/sec' -ErrorAction Stop; $r = $c.CounterSamples[0].CookedValue; $w = $c.CounterSamples[1].CookedValue; Write-Output "$([math]::Round($r/1MB,1))|$([math]::Round($w/1MB,1))"`,
    ]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const parts = output.trim().split("|");
    if (parts.length >= 2) {
      cachedDiskIO = {
        readMBps: parseFloat(parts[0]) || 0,
        writeMBps: parseFloat(parts[1]) || 0,
      };
    }
  } catch {}
}

async function refreshThermalThrottling() {
  try {
    const proc = Bun.spawn([
      "powershell",
      "-NoProfile",
      "-Command",
      `$c = Get-Counter '\\Processor Information(_Total)\\% Processor Performance' -ErrorAction Stop; Write-Output $c.CounterSamples[0].CookedValue`,
    ]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const cpuPerf = parseFloat(output.trim());
    const gpuThrottling = cachedGpu.temp !== null && cachedGpu.temp > 90;
    cachedThermalThrottling = (!isNaN(cpuPerf) && cpuPerf < 95) || gpuThrottling;
  } catch {}
}

async function refreshPendingUpdates() {
  try {
    const proc = Bun.spawn([
      "powershell",
      "-NoProfile",
      "-Command",
      `try { $s = New-Object -ComObject Microsoft.Update.Session; $u = $s.CreateUpdateSearcher().Search('IsInstalled=0').Updates.Count; Write-Output $u } catch { Write-Output 0 }`,
    ]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    cachedPendingUpdates = parseInt(output.trim(), 10) || 0;
  } catch {}
}

async function refreshEventLog() {
  try {
    const proc = Bun.spawn([
      "powershell",
      "-NoProfile",
      "-Command",
      `$evts = Get-WinEvent -FilterHashtable @{LogName='Application';Level=1,2;StartTime=(Get-Date).AddHours(-1)} -MaxEvents 10 -ErrorAction SilentlyContinue; if ($evts) { $c = $evts.Count; $last = $evts[0]; Write-Output "$c|$($last.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss'))|$($last.Message.Substring(0,[math]::Min(200,$last.Message.Length)))" } else { Write-Output "0||" }`,
    ]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const parts = output.trim().split("|");
    const count = parseInt(parts[0], 10) || 0;
    cachedEventLog = {
      count,
      lastTime: parts[1] && parts[1].trim() ? parts[1].trim() : null,
      lastMessage: parts[2] && parts[2].trim() ? parts[2].trim().substring(0, 200) : null,
    };
  } catch {}
}

/** Start background polling loops for slow collectors */
export function startSystemPolling() {
  // CPU: sample every 2s (non-blocking, just reads os.cpus())
  sampleCpu(); // prime first reading
  setInterval(sampleCpu, 2_000);

  // GPU: refresh every 5s
  refreshGpu();
  setInterval(refreshGpu, 5_000);

  // Disk: refresh every 60s
  refreshDisk();
  setInterval(refreshDisk, 60_000);

  // Disk I/O: refresh every 5s
  refreshDiskIO();
  setInterval(refreshDiskIO, 5_000);

  // Thermal throttling: refresh every 10s
  refreshThermalThrottling();
  setInterval(refreshThermalThrottling, 10_000);

  // Pending updates: refresh every 5 min (slow COM call)
  refreshPendingUpdates();
  setInterval(refreshPendingUpdates, 300_000);

  // Windows Event Log: refresh every 60s
  refreshEventLog();
  setInterval(refreshEventLog, 60_000);
}

/** Fast snapshot from cached values + instant reads */
export function collectSystem(): SystemMetrics {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    cpuUsage: cachedCpu,
    cpuModel: cpus[0]?.model || "Unknown",
    cpuCores: cpus.length,
    ramTotalMB: Math.round(totalMem / (1024 * 1024)),
    ramUsedMB: Math.round(usedMem / (1024 * 1024)),
    ramPercent: Math.round((usedMem / totalMem) * 1000) / 10,
    gpuName: cachedGpu.name,
    gpuUsage: cachedGpu.usage,
    gpuMemUsedMB: cachedGpu.memUsedMB,
    gpuMemTotalMB: cachedGpu.memTotalMB,
    gpuTemp: cachedGpu.temp,
    diskTotalMB: cachedDisk.totalMB,
    diskUsedMB: cachedDisk.usedMB,
    diskPercent: cachedDisk.percent,
    diskReadMBps: cachedDiskIO.readMBps,
    diskWriteMBps: cachedDiskIO.writeMBps,
    thermalThrottling: cachedThermalThrottling,
    pendingUpdates: cachedPendingUpdates,
    eventLog: cachedEventLog,
    uptime: Math.round(os.uptime()),
  };
}
