import * as os from "os";
import type { SystemMetrics } from "../types";

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

let cachedCpu = 0;
let cachedGpu: GpuInfo = { name: null, usage: null, memUsedMB: null, memTotalMB: null, temp: null };
let cachedDisk: DiskInfo = { totalMB: 0, usedMB: 0, percent: 0 };

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
    uptime: Math.round(os.uptime()),
  };
}
