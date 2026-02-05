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

export interface VuosProcessInfo {
  responding: boolean;
  threads: number;
  handles: number;
  priority: string;
  startTime: string | null;
  cpuTimeMs: number;
  gpuMemoryMB: number | null;
}

export interface AppMetrics {
  vuosProcessRunning: boolean;
  serverProcessRunning: boolean;
  serverVersion: string;
  vuosMemoryMB: number | null;
  vuosProcess: VuosProcessInfo | null;
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

// --- Operational Mode ---

export type OperationalMode = "STARTING" | "READY" | "DEGRADED" | "CRITICAL" | "SHUTTING_DOWN";

export type ConditionLevel = "DEGRADED" | "CRITICAL";

// --- Health (bounded retained summary) ---

export interface HealthPayload {
  schema: "vu.watchdog.health.v1";
  ts: number;
  wallId: string;
  mode: OperationalMode;
  conditions: string[];
  system: { cpu: number; mem: number; gpu: number | null; disk: number };
  network: { internet: boolean; latencyMs: number | null; localServer: boolean; peers: number };
  app: { vuos: "RUNNING" | "STOPPED"; server: "RUNNING" | "STOPPED"; lockHealthy: boolean; recentErrors: number };
}

// --- Events ---

export type EventSeverity = "INFO" | "WARN" | "ERROR" | "CRITICAL";

export interface EventPayload {
  schema: "vu.watchdog.event.v1";
  ts: number;
  wallId: string;
  type: string;
  severity: EventSeverity;
  details: Record<string, any>;
}

// --- Commands ---

export type CommandType =
  | "RESTART_VUOS"
  | "START_VUOS"
  | "STOP_VUOS"
  | "QUIT_WATCHDOG"
  | "SWITCH_BROKER"
  | "REQUEST_TELEMETRY"
  | "REQUEST_CONFIG";

export interface CommandPayload {
  schema: "vu.watchdog.command.v1";
  ts: number;
  commandId: string;
  ttlMs: number;
  type: CommandType;
  args: Record<string, any>;
}

export type AckStatus = "RECEIVED" | "ACCEPTED" | "APPLIED" | "REJECTED" | "FAILED" | "EXPIRED";

export interface AckPayload {
  schema: "vu.watchdog.ack.v1";
  ts: number;
  commandId: string;
  status: AckStatus;
  message: string;
  details: Record<string, any>;
}

// --- Lease ---

export interface LeasePayload {
  schema: "vu.watchdog.lease.v1";
  ts: number;
  owner: string;
  expiresTs: number;
}
