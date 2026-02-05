import type { CommandPayload, CommandType, AckPayload, AckStatus } from "./types";
import { publishAck } from "./mqtt";
import { validateLease, type LeaseManager } from "./lease";
import type { WatchdogEventEmitter } from "./events";

// --- Command definitions ---

export interface CommandDef {
  type: CommandType;
  requiresLease: boolean;
  localBypass: boolean;
  handler: (args: Record<string, any>) => Promise<{ message: string; details: Record<string, any> }>;
}

// Legacy action → CommandType mapping
const LEGACY_ACTION_MAP: Record<string, CommandType> = {
  "restart-vuos": "RESTART_VUOS",
  "start-vuos": "START_VUOS",
  "stop-vuos": "STOP_VUOS",
  "quit": "QUIT_WATCHDOG",
  "switch-broker": "SWITCH_BROKER",
  "start-stream": "START_STREAM",
  "stop-stream": "STOP_STREAM",
  "set-stream-quality": "SET_STREAM_QUALITY",
};

// --- Idempotency store ---

interface IdempotencyEntry {
  ack: AckPayload;
  expiresAt: number;
}

const IDEMPOTENCY_TTL_MS = 60_000;
const idempotencyStore = new Map<string, IdempotencyEntry>();

// Cleanup old entries every 30s
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of idempotencyStore) {
    if (now >= entry.expiresAt) {
      idempotencyStore.delete(id);
    }
  }
}, 30_000);

// --- Command Processor ---

export class CommandProcessor {
  private wallId: string;
  private registry = new Map<CommandType, CommandDef>();
  private leaseManager: LeaseManager;
  private eventEmitter: WatchdogEventEmitter;
  private onAck: (ack: AckPayload) => void;

  constructor(
    wallId: string,
    leaseManager: LeaseManager,
    eventEmitter: WatchdogEventEmitter,
    onAck: (ack: AckPayload) => void,
  ) {
    this.wallId = wallId;
    this.leaseManager = leaseManager;
    this.eventEmitter = eventEmitter;
    this.onAck = onAck;
  }

  registerCommand(def: CommandDef): void {
    this.registry.set(def.type, def);
  }

  /** Handle a command from MQTT command/{clientId} topic */
  async handle(payload: CommandPayload, clientId: string, isLocal: boolean): Promise<AckPayload> {
    this.eventEmitter.emitLifecycle("COMMAND_RECEIVED", "INFO", {
      type: payload.type,
      commandId: payload.commandId,
      clientId,
      isLocal,
    });

    // 1. Idempotency check
    const existing = idempotencyStore.get(payload.commandId);
    if (existing) {
      this.sendAck(clientId, existing.ack);
      return existing.ack;
    }

    // 2. TTL check
    if (payload.ts + payload.ttlMs < Date.now()) {
      const ack = this.makeAck(payload.commandId, "EXPIRED", "Command TTL exceeded", {});
      this.sendAck(clientId, ack);
      return ack;
    }

    // 3. Lookup command
    const def = this.registry.get(payload.type);
    if (!def) {
      const ack = this.makeAck(payload.commandId, "REJECTED", `Unknown command: ${payload.type}`, {});
      this.sendAck(clientId, ack);
      return ack;
    }

    // 4. Lease check
    const leaseResult = validateLease(this.leaseManager, clientId, isLocal, def);
    if (!leaseResult.allowed) {
      if (isLocal && def.localBypass) {
        this.eventEmitter.emitLifecycle("LOCAL_OVERRIDE_USED", "WARN", {
          commandType: payload.type,
          clientId,
        });
      } else {
        const ack = this.makeAck(payload.commandId, "REJECTED", leaseResult.reason!, {});
        this.sendAck(clientId, ack);
        return ack;
      }
    }

    // 5. Ack RECEIVED
    const receivedAck = this.makeAck(payload.commandId, "RECEIVED", "Command received", {});
    this.sendAck(clientId, receivedAck);

    // 6. Execute
    try {
      const result = await def.handler(payload.args);
      const ack = this.makeAck(payload.commandId, "APPLIED", result.message, result.details);
      idempotencyStore.set(payload.commandId, { ack, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
      this.sendAck(clientId, ack);
      return ack;
    } catch (err: any) {
      const ack = this.makeAck(payload.commandId, "FAILED", err.message || "Execution failed", {});
      this.sendAck(clientId, ack);
      return ack;
    }
  }

  /** Handle a legacy control message ({"action":"restart-vuos"}) */
  async handleLegacy(payload: Record<string, any>): Promise<AckPayload | null> {
    const action = payload.action as string;
    if (!action) return null;

    const commandType = LEGACY_ACTION_MAP[action];
    if (!commandType) {
      console.log(`[commands] Unknown legacy action: ${action}`);
      return null;
    }

    const commandPayload: CommandPayload = {
      schema: "vu.watchdog.command.v1",
      ts: Date.now(),
      commandId: `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ttlMs: 15_000,
      type: commandType,
      args: payload.args || {},
    };

    return this.handle(commandPayload, "legacy", false);
  }

  /** Handle a command from HTTP API or WebSocket (always local) */
  async handleLocal(type: CommandType, args: Record<string, any> = {}): Promise<AckPayload> {
    const commandPayload: CommandPayload = {
      schema: "vu.watchdog.command.v1",
      ts: Date.now(),
      commandId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ttlMs: 15_000,
      type,
      args,
    };

    return this.handle(commandPayload, "local-api", true);
  }

  private makeAck(commandId: string, status: AckStatus, message: string, details: Record<string, any>): AckPayload {
    return {
      schema: "vu.watchdog.ack.v1",
      ts: Date.now(),
      commandId,
      status,
      message,
      details,
    };
  }

  private sendAck(clientId: string, ack: AckPayload): void {
    // Publish to MQTT
    publishAck(this.wallId, clientId, ack);
    // Broadcast to WebSocket
    this.onAck(ack);
  }
}
