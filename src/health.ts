import type { TelemetryPayload, OperationalMode, ConditionLevel, HealthPayload } from "./types";

// --- Condition definitions ---

export interface ConditionDef {
  id: string;
  level: ConditionLevel;
  debounceMs: number;
  evaluate: (t: TelemetryPayload) => boolean;
}

const CONDITIONS: ConditionDef[] = [
  // CRITICAL
  { id: "VUOS_DOWN", level: "CRITICAL", debounceMs: 10_000, evaluate: (t) => !t.app.vuosProcessRunning },
  { id: "SERVER_DOWN", level: "CRITICAL", debounceMs: 10_000, evaluate: (t) => !t.app.serverProcessRunning },
  { id: "DISK_FULL", level: "CRITICAL", debounceMs: 0, evaluate: (t) => t.system.diskPercent >= 97 },
  { id: "THERMAL_THROTTLING", level: "CRITICAL", debounceMs: 0, evaluate: (t) => t.system.thermalThrottling },
  {
    id: "LOCK_STALE", level: "CRITICAL", debounceMs: 0,
    evaluate: (t) => t.app.serverLock !== null && !t.app.serverLock.healthy && (t.app.serverLock.heartbeatAgeMs ?? 0) > 15_000,
  },

  // DEGRADED
  { id: "INTERNET_OFFLINE", level: "DEGRADED", debounceMs: 30_000, evaluate: (t) => !t.network.internetOnline },
  { id: "LATENCY_HIGH", level: "DEGRADED", debounceMs: 60_000, evaluate: (t) => (t.network.latencyMs ?? 0) > 250 },
  { id: "DISK_HIGH", level: "DEGRADED", debounceMs: 0, evaluate: (t) => t.system.diskPercent >= 90 && t.system.diskPercent < 97 },
  { id: "GPU_PROBE_FAILED", level: "DEGRADED", debounceMs: 60_000, evaluate: (t) => t.system.gpuName === null },
  { id: "ERRORS_HIGH", level: "DEGRADED", debounceMs: 0, evaluate: (t) => t.app.logs.recentErrorCount >= 5 },
];

// --- Condition state tracker ---

export interface ConditionState {
  id: string;
  level: ConditionLevel;
  rawActive: boolean;        // condition triggered (before debounce)
  active: boolean;           // condition active (after debounce)
  activeSince: number | null; // timestamp when rawActive became true
}

const conditionStates = new Map<string, ConditionState>();

// Initialize all conditions
for (const def of CONDITIONS) {
  conditionStates.set(def.id, {
    id: def.id,
    level: def.level,
    rawActive: false,
    active: false,
    activeSince: null,
  });
}

export function evaluateConditions(telemetry: TelemetryPayload): ConditionState[] {
  const now = Date.now();

  for (const def of CONDITIONS) {
    const state = conditionStates.get(def.id)!;
    const triggered = def.evaluate(telemetry);

    if (triggered) {
      if (!state.rawActive) {
        // Just became triggered
        state.rawActive = true;
        state.activeSince = now;
      }
      // Check debounce
      if (def.debounceMs === 0 || (now - state.activeSince!) >= def.debounceMs) {
        state.active = true;
      }
    } else {
      state.rawActive = false;
      state.active = false;
      state.activeSince = null;
    }
  }

  return Array.from(conditionStates.values());
}

// --- Mode computation (pure function) ---

const WARMUP_SEC = 5;
const startTime = Date.now();
let shuttingDown = false;

export function setShuttingDown(value: boolean) {
  shuttingDown = value;
}

export function computeMode(conditions: ConditionState[]): OperationalMode {
  if (shuttingDown) return "SHUTTING_DOWN";

  const startupAge = (Date.now() - startTime) / 1000;
  if (startupAge < WARMUP_SEC) return "STARTING";

  let hasCritical = false;
  let hasDegraded = false;

  for (const c of conditions) {
    if (!c.active) continue;
    if (c.level === "CRITICAL") hasCritical = true;
    if (c.level === "DEGRADED") hasDegraded = true;
  }

  if (hasCritical) return "CRITICAL";
  if (hasDegraded) return "DEGRADED";
  return "READY";
}

// --- Health payload builder ---

export function buildHealth(
  wallId: string,
  telemetry: TelemetryPayload,
  mode: OperationalMode,
  conditions: ConditionState[],
): HealthPayload {
  const activeConditionIds = conditions.filter((c) => c.active).map((c) => c.id);

  return {
    schema: "vu.watchdog.health.v1",
    ts: Date.now(),
    wallId,
    mode,
    conditions: activeConditionIds,
    system: {
      cpu: Math.round(telemetry.system.cpuUsage) / 100,
      mem: Math.round(telemetry.system.ramPercent) / 100,
      gpu: telemetry.system.gpuUsage !== null ? Math.round(telemetry.system.gpuUsage) / 100 : null,
      disk: Math.round(telemetry.system.diskPercent) / 100,
    },
    network: {
      internet: telemetry.network.internetOnline,
      latencyMs: telemetry.network.latencyMs,
      localServer: telemetry.network.localServerReachable,
      peers: telemetry.network.connectedPeers,
    },
    app: {
      vuos: telemetry.app.vuosProcessRunning ? "RUNNING" : "STOPPED",
      server: telemetry.app.serverProcessRunning ? "RUNNING" : "STOPPED",
      lockHealthy: telemetry.app.serverLock?.healthy ?? false,
      recentErrors: telemetry.app.logs.recentErrorCount,
    },
  };
}
