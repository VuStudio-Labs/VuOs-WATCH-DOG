export interface EventLogMetrics {
  count: number;
  lastMessage: string | null;
  lastTime: string | null;
}

export interface SystemMetrics {
  cpuUsage: number;
  cpuModel: string;
  cpuCores: number;
  ramTotalMB: number;
  ramUsedMB: number;
  ramPercent: number;
  gpuName: string | null;
  gpuUsage: number | null;
  gpuMemUsedMB: number | null;
  gpuMemTotalMB: number | null;
  gpuTemp: number | null;
  diskTotalMB: number;
  diskUsedMB: number;
  diskPercent: number;
  diskReadMBps: number;
  diskWriteMBps: number;
  thermalThrottling: boolean;
  pendingUpdates: number;
  eventLog: EventLogMetrics;
  uptime: number;
}

export interface NetworkMetrics {
  internetOnline: boolean;
  latencyMs: number | null;
  localServerReachable: boolean;
  connectedPeers: number;
}

export interface ServerLockInfo {
  pid: number | null;
  startTime: number | null;
  lastHeartbeat: number | null;
  heartbeatAgeMs: number | null;
  healthy: boolean;
}

export interface LogMetrics {
  recentErrorCount: number;
  lastError: string | null;
  lastErrorTime: string | null;
}

export interface AppMetrics {
  vuosProcessRunning: boolean;
  serverProcessRunning: boolean;
  serverVersion: string;
  vuosMemoryMB: number | null;
  crashCountToday: number;
  serverLock: ServerLockInfo;
  logs: LogMetrics;
}

export interface TelemetryPayload {
  timestamp: number;
  wallId: string;
  system: SystemMetrics;
  network: NetworkMetrics;
  app: AppMetrics;
}
