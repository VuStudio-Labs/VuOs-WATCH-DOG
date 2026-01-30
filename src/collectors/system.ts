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

async function refreshGpu() {
  try {
    const proc = Bun.spawn([
      "nvidia-smi",
      "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
      "--format=csv,noheader,nounits",
    ]);
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0 || !output.trim()) return;

    const parts = output.trim().split(",").map((s) => s.trim());
    cachedGpu = {
      name: parts[0] || null,
      usage: parts[1] ? parseInt(parts[1], 10) : null,
      memUsedMB: parts[2] ? parseInt(parts[2], 10) : null,
      memTotalMB: parts[3] ? parseInt(parts[3], 10) : null,
      temp: parts[4] ? parseInt(parts[4], 10) : null,
    };
  } catch {}
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
