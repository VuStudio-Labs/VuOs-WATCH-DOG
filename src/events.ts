import type { EventPayload, EventSeverity, OperationalMode } from "./types";
import type { ConditionState } from "./health";

export type EventCallback = (event: EventPayload) => void;

// Severity mapping for condition events
const CONDITION_SEVERITY: Record<string, EventSeverity> = {
  VUOS_DOWN: "CRITICAL",
  SERVER_DOWN: "CRITICAL",
  DISK_FULL: "CRITICAL",
  THERMAL_THROTTLING: "CRITICAL",
  LOCK_STALE: "ERROR",
  INTERNET_OFFLINE: "WARN",
  LATENCY_HIGH: "WARN",
  DISK_HIGH: "WARN",
  GPU_PROBE_FAILED: "ERROR",
  ERRORS_HIGH: "WARN",
};

const REMINDER_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export class WatchdogEventEmitter {
  private wallId: string;
  private onEvent: EventCallback;
  private previousStates = new Map<string, boolean>();
  private reminderTimers = new Map<string, number>(); // conditionId → last reminder timestamp
  private previousMode: OperationalMode | null = null;

  constructor(wallId: string, onEvent: EventCallback) {
    this.wallId = wallId;
    this.onEvent = onEvent;
  }

  /** Call every 2s with updated condition states. Emits edge-triggered events. */
  updateConditions(conditions: ConditionState[]): void {
    for (const condition of conditions) {
      const prev = this.previousStates.get(condition.id) ?? false;
      const curr = condition.active;

      if (!prev && curr) {
        // false → true: condition just activated
        this.emit(`${condition.id}_ON`, CONDITION_SEVERITY[condition.id] || "WARN", {});
        this.reminderTimers.set(condition.id, Date.now());
      } else if (prev && !curr) {
        // true → false: condition just cleared
        this.emit(`${condition.id}_OFF`, "INFO", {});
        this.reminderTimers.delete(condition.id);
      } else if (prev && curr) {
        // Still active — check if reminder is due
        const lastReminder = this.reminderTimers.get(condition.id) ?? 0;
        if (Date.now() - lastReminder >= REMINDER_INTERVAL_MS) {
          this.emit(`${condition.id}_REMINDER`, CONDITION_SEVERITY[condition.id] || "WARN", {
            activeSince: condition.activeSince,
          });
          this.reminderTimers.set(condition.id, Date.now());
        }
      }

      this.previousStates.set(condition.id, curr);
    }
  }

  /** Track mode transitions and emit MODE_CHANGED events */
  updateMode(mode: OperationalMode): void {
    if (this.previousMode !== null && this.previousMode !== mode) {
      const severity: EventSeverity =
        mode === "CRITICAL" ? "CRITICAL" :
        mode === "DEGRADED" ? "WARN" :
        "INFO";

      this.emit("MODE_CHANGED", severity, {
        from: this.previousMode,
        to: mode,
      });
    }
    this.previousMode = mode;
  }

  /** Emit a one-shot lifecycle event (not edge-triggered) */
  emitLifecycle(type: string, severity: EventSeverity, details: Record<string, any> = {}): void {
    this.emit(type, severity, details);
  }

  private emit(type: string, severity: EventSeverity, details: Record<string, any>): void {
    const event: EventPayload = {
      schema: "vu.watchdog.event.v1",
      ts: Date.now(),
      wallId: this.wallId,
      type,
      severity,
      details,
    };
    console.log(`[event] ${severity} ${type}`, Object.keys(details).length > 0 ? JSON.stringify(details) : "");
    this.onEvent(event);
  }
}
