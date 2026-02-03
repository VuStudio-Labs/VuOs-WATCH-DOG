# Watchdog v2 — Production Ops Plane Implementation Plan

## Goal

Upgrade vu-watchdog from a simple telemetry publisher to a production-grade ops plane with:
- Deterministic health mode (`STARTING → READY → DEGRADED → CRITICAL → SHUTTING_DOWN`)
- Edge-triggered event stream (no spam, `_ON`/`_OFF` transitions)
- Command/ack control plane with idempotency (replaces fire-and-forget)
- Lease arbitration (prevents multi-operator conflicts)
- UNS shadow mirror (future `vu/v1/...` namespace)
- 100% backward compatibility with existing `watchdog/{wallId}/...` consumers

---

## New Files

| File | Purpose |
|------|---------|
| `src/health.ts` | Mode state machine + condition tracker |
| `src/events.ts` | Edge-triggered event emitter with dedup |
| `src/commands.ts` | Command/ack processor with idempotency |
| `src/lease.ts` | Lease arbitration (acquire/renew/enforce) |
| `src/uns.ts` | UNS shadow mirror publisher |

## Modified Files

| File | Changes |
|------|---------|
| `src/types.ts` | Add HealthPayload, EventPayload, CommandPayload, AckPayload, LeasePayload, OperationalMode types |
| `src/mqtt.ts` | Add new topics, new publish functions, `command/+` subscription, UNS mirror toggle |
| `src/server.ts` | Add WebSocket event/ack/health broadcast, inbound WS messages for commands from local dashboard |
| `src/index.ts` | Wire health computation, events, command handler, lease, UNS into main loop |
| `index.html` | Event log panel, ack feedback on buttons, health mode banner, lease indicator |

---

## 1. Health Mode State Machine (`src/health.ts`)

### 5-State Operational Mode

| Mode | Meaning |
|------|---------|
| `STARTING` | Watchdog booted, collectors warming up, no stable snapshot yet |
| `READY` | Everything nominal |
| `DEGRADED` | Non-critical impairment; demo may still run |
| `CRITICAL` | Wall experience is compromised or unsafe |
| `SHUTTING_DOWN` | Quit requested or process exiting |

### Mode Computation (pure function, "worst active condition" wins)

```
if shuttingDown          → SHUTTING_DOWN
if startupAge < WARMUP   → STARTING
if any CRITICAL condition → CRITICAL
if any DEGRADED condition → DEGRADED
else                      → READY
```

### Condition Thresholds

**CRITICAL**

| ID | Trigger | Debounce |
|----|---------|----------|
| `VUOS_DOWN` | `vuosProcessRunning == false` | 10s |
| `SERVER_DOWN` | `serverProcessRunning == false` | 10s |
| `DISK_FULL` | `diskPercent >= 97` | 0 |
| `THERMAL_THROTTLING` | `thermalThrottling == true` | 0 |
| `LOCK_STALE` | `!lockHealthy && heartbeatAgeMs > 15000` | 0 |

**DEGRADED**

| ID | Trigger | Debounce |
|----|---------|----------|
| `INTERNET_OFFLINE` | `internetOnline == false` | 30s |
| `LATENCY_HIGH` | `latencyMs > 250` | 60s |
| `DISK_HIGH` | `diskPercent >= 90` | 0 |
| `GPU_PROBE_FAILED` | `gpuName == null` after warmup | 60s |
| `ERRORS_HIGH` | `recentErrorCount >= 5` | 0 |

Thresholds are configurable (future: `watchdog.config.json`).

### Health Payload (bounded retained summary)

```json
{
  "schema": "vu.watchdog.health.v1",
  "ts": 1706832985095,
  "wallId": "5538",
  "mode": "READY",
  "conditions": [],
  "system": { "cpu": 0.16, "mem": 0.62, "gpu": 0.08, "disk": 0.84 },
  "network": { "internet": true, "latencyMs": 42, "localServer": true, "peers": 3 },
  "app": { "vuos": "RUNNING", "server": "RUNNING", "lockHealthy": true, "recentErrors": 0 }
}
```

---

## 2. Edge-Triggered Events (`src/events.ts`)

### Dedupe Rule

Events are **edge-triggered**, not spammed every poll cycle:
- `false → true`: emit `{TYPE}_ON`
- `true → false`: emit `{TYPE}_OFF`
- Still active > 10 minutes: emit `{TYPE}_REMINDER`
- No change: emit nothing

### Severity Levels

| Severity | Examples |
|----------|----------|
| `INFO` | `WATCHDOG_STARTED`, `BROKER_CONNECTED`, `CONFIG_LOADED` |
| `WARN` | `INTERNET_OFFLINE`, `DISK_HIGH`, `LATENCY_HIGH`, `BROKER_SWITCHED` |
| `ERROR` | `GPU_PROBE_FAILED`, `LOCK_STALE`, `VUOS_CRASHED` |
| `CRITICAL` | `THERMAL_THROTTLING`, `DISK_FULL`, `VUOS_DOWN`, `SERVER_DOWN` |

### Lifecycle Events (always emitted)

| Event | When | Severity |
|-------|------|----------|
| `WATCHDOG_STARTED` | On boot | INFO |
| `WATCHDOG_SHUTTING_DOWN` | On quit | INFO |
| `BROKER_CONNECTED` | On MQTT connect | INFO |
| `BROKER_SWITCHED` | On broker switch | WARN |
| `VUOS_RESTARTED` | On restart command executed | WARN |
| `VUOS_CRASHED` | On crash detection (PID change) | ERROR |
| `MODE_CHANGED` | On mode transition | varies |
| `COMMAND_RECEIVED` | On any command received | INFO |
| `LOCAL_OVERRIDE_USED` | On local bypass of lease | WARN |

### Event Payload

```json
{
  "schema": "vu.watchdog.event.v1",
  "ts": 1706832985095,
  "wallId": "5538",
  "type": "INTERNET_OFFLINE_ON",
  "severity": "WARN",
  "details": { "lastLatencyMs": 340 }
}
```

---

## 3. Command/Ack Control Plane (`src/commands.ts`)

### Flow

1. Command arrives on `watchdog/{wallId}/command/{clientId}`
2. Parse `CommandPayload`, extract `clientId` from topic
3. **Idempotency check**: if `commandId` seen in last 60s → ack `APPLIED` (dedup)
4. **TTL check**: if `ts + ttlMs < now` → ack `EXPIRED`
5. **Lease check**: validate ownership for destructive commands
6. Ack `RECEIVED` immediately
7. Execute command
8. Ack `APPLIED` or `FAILED`

### Client ID Format

`clientId = <clientType>-<shortId>` (e.g., `local-ui-6f3a`, `ops-dashboard-1c2d`)

Watchdog subscribes to `command/+` (one subscription), parses `clientId` from topic, publishes acks to `ack/{clientId}`.

### Command Registry

| Command | requiresLease | localBypass | Description |
|---------|---------------|-------------|-------------|
| `RESTART_VUOS` | true | true | Kill + relaunch Vu One.exe |
| `START_VUOS` | true | true | Launch only |
| `STOP_VUOS` | true | false | Clean stop (fallback kill) |
| `QUIT_WATCHDOG` | true | false | Exit watchdog process |
| `SWITCH_BROKER` | true | false | Change active MQTT broker |
| `REQUEST_TELEMETRY` | false | true | Force immediate publish |
| `REQUEST_CONFIG` | false | true | Force config republish |

### Command Payload

```json
{
  "schema": "vu.watchdog.command.v1",
  "ts": 1706832985095,
  "commandId": "01HZX3ABCDEF1234567890",
  "ttlMs": 15000,
  "type": "RESTART_VUOS",
  "args": {}
}
```

### Ack Payload

```json
{
  "schema": "vu.watchdog.ack.v1",
  "ts": 1706832986123,
  "commandId": "01HZX3ABCDEF1234567890",
  "status": "APPLIED",
  "message": "Vu One.exe restarted",
  "details": { "pidNew": 5678 }
}
```

### Ack Status Lifecycle

`RECEIVED → ACCEPTED → APPLIED` (happy path)
`RECEIVED → REJECTED` (lease/auth failure)
`RECEIVED → FAILED` (execution error)
`EXPIRED` (TTL exceeded before delivery)

### Legacy Shim

`watchdog/{wallId}/control` messages like `{"action":"restart-vuos"}` are converted to commands internally with auto-generated `commandId`. Acks go to `ack/legacy`.

### Idempotency

In-memory `Map<commandId, AckPayload>` with 60s TTL. Duplicate commands ack as `APPLIED` without re-executing.

---

## 4. Lease Arbitration (`src/lease.ts`)

### Purpose

Prevents two operators from fighting over the same wall. Only the lease holder can run destructive commands.

### Lease Payload

```json
{
  "schema": "vu.watchdog.lease.v1",
  "ts": 1706832985095,
  "owner": "ops-dashboard-1c2d",
  "expiresTs": 1706833045095
}
```

### Enforcement (in Watchdog)

- `requiresLease == false` → allowed
- Local + `localBypass == true` → allowed (emit `LOCAL_OVERRIDE_USED`)
- No active lease → rejected
- Lease expired → rejected
- `lease.owner !== clientId` → rejected
- Match → allowed

### Local Bypass

HTTP API and WebSocket commands are always "local". MQTT commands are always "remote".

Local bypass allowed for: `RESTART_VUOS`, `START_VUOS`, `REQUEST_TELEMETRY`, `REQUEST_CONFIG`
No bypass for: `STOP_VUOS`, `QUIT_WATCHDOG`, `SWITCH_BROKER`

### Lease Lifecycle

- Expires in 30-60s, must be renewed
- Client publishes to `watchdog/{wallId}/lease` to acquire/renew
- Watchdog validates and accepts/rejects
- Retained on broker so new subscribers see current state

---

## 5. UNS Shadow Mirror (`src/uns.ts`)

### Configuration

```
UNS_ENABLED=false          (default: disabled)
UNS_PREFIX=vu/v1/asset/wall  (default prefix)
UNS_MIRROR_TELEMETRY=false  (default: don't mirror raw 2s telemetry)
```

### Mirror Mapping

| Watchdog Topic | UNS Topic |
|---------------|-----------|
| `watchdog/{wId}/status` | `vu/v1/asset/wall/{wId}/watchdog/presence` |
| `watchdog/{wId}/health` | `vu/v1/asset/wall/{wId}/watchdog/state/reported` |
| `watchdog/{wId}/event` | `vu/v1/asset/wall/{wId}/watchdog/event` |
| `watchdog/{wId}/config` | `vu/v1/asset/wall/{wId}/watchdog/config` |
| `watchdog/{wId}/command/{cId}` | `vu/v1/asset/wall/{wId}/watchdog/command/{cId}` |
| `watchdog/{wId}/ack/{cId}` | `vu/v1/asset/wall/{wId}/watchdog/ack/{cId}` |
| `watchdog/{wId}/lease` | `vu/v1/asset/wall/{wId}/watchdog/control/lease` |
| `watchdog/{wId}/telemetry` | `vu/v1/asset/wall/{wId}/watchdog/telemetry/system` (opt-in) |

Mirrored with same QoS and retain settings as the original publish.

---

## 6. MQTT Topic Summary

### All Topics

| Topic | QoS | Retained | Direction | Interval |
|-------|-----|----------|-----------|----------|
| `watchdog/{wId}/status` | 1 | Yes | Outbound | On connect/disconnect (LWT) |
| `watchdog/{wId}/telemetry` | 0 | **No** (changed) | Outbound | 2s |
| `watchdog/{wId}/health` | 1 | Yes | Outbound | 2s |
| `watchdog/{wId}/config` | 0 | Yes | Outbound | 60s |
| `watchdog/{wId}/commands` | 0 | No | Outbound | Real-time (OSC) |
| `watchdog/{wId}/event` | 1 | No | Outbound | Edge-triggered |
| `watchdog/{wId}/command/{clientId}` | 1 | No | Inbound | On-demand |
| `watchdog/{wId}/ack/{clientId}` | 1 | No | Outbound | Per-command |
| `watchdog/{wId}/control` | 1 | No | Inbound | Legacy |
| `watchdog/{wId}/lease` | 1 | Yes | Both | On acquire/renew |

### Subscriptions (Watchdog)

```
watchdog/{wallId}/command/+   (QoS 1)
watchdog/{wallId}/lease        (QoS 1)
watchdog/{wallId}/control      (QoS 1)  ← legacy
```

---

## 7. WebSocket Protocol Updates

### Server → Client

| Type | Data | When |
|------|------|------|
| `telemetry` | `TelemetryPayload` | Every 2s |
| `health` | `HealthPayload` | Every 2s |
| `config` | Config + broker info | On connect + 60s |
| `command` | OSC command data | Real-time |
| `event` | `EventPayload` | Edge-triggered |
| `ack` | `AckPayload` | Per-command |
| `broker-switched` | `{activeBrokerId}` | On switch |

### Client → Server (new, local only)

| Type | Data | Description |
|------|------|-------------|
| `command` | `{type, args}` | Dashboard sends command |

---

## 8. HTTP API Changes

Existing endpoints become thin wrappers routing through the command processor:

| Endpoint | Maps To | Notes |
|----------|---------|-------|
| `POST /api/start-vuos` | `START_VUOS` | Always local, lease bypass |
| `POST /api/restart-vuos` | `RESTART_VUOS` | Always local, lease bypass |
| `POST /api/switch-broker` | `SWITCH_BROKER` | Always local, NO lease bypass |
| `POST /api/quit` | `QUIT_WATCHDOG` | Always local, NO lease bypass |

Response includes the ack payload so the caller gets confirmation.

---

## 9. Dashboard Updates (`index.html`)

### Health Mode Banner
- Top of page, color-coded: green=READY, amber=DEGRADED, red=CRITICAL, blue=STARTING, gray=SHUTTING_DOWN
- Shows active conditions list

### Events Panel
- Scrollable log with timestamp, severity color, type, details
- Max 100 entries, oldest pruned
- Colors: blue=INFO, amber=WARN, red=ERROR, dark red=CRITICAL

### Ack Feedback
- Buttons show status: "Received... Applied" or "Rejected: lease required"
- Disabled while command in-flight

### Lease Indicator
- Shows current holder + expiry countdown
- "Acquire Lease" button for local dashboard

---

## 10. Backward Compatibility

| Consumer | Status | Notes |
|----------|--------|-------|
| WebSocket `telemetry` subscribers | Works | Same payload, same interval |
| MQTT `telemetry` subscribers | Works | Same payload, no longer retained |
| `status` LWT | Works | Unchanged |
| `control` commands | Works | Shimmed through command processor |
| `config` | Works | Unchanged |
| `commands` (OSC) | Works | Unchanged |

Nothing is removed. Nothing is renamed. New features are additive.
