# Vu Watchdog — Architecture & Technical Documentation

## Overview

Vu Watchdog is a system health monitor for Vu One OS display wall installations. It runs as a single Windows executable, collects telemetry from the local machine, and publishes it over MQTT and WebSocket for local and remote monitoring.

## Data Flow

```
Vu One OS Installation
  app.config.json ─────┐
  system.config.json ───┤
  vu-server.lock ───────┤
  logs/error.log ───────┤
  /connected-users API ─┤
  OSC UDP :1231 ────────┤
                        ▼
              vu-watchdog.exe
             ┌──────────────────┐
             │  Collectors      │
             │  (background)    │
             │                  │
             │  Snapshot (2s)   │
             └───────┬──────────┘
                     │
         ┌───────────┼───────────┐
         ▼           ▼           ▼
    MQTT Broker   WebSocket   System Tray
    (remote)      :3200/ws    (notification
                  (local)      area)
```

## Startup Sequence

1. **Single instance check** — probes `localhost:3200`. If a response comes back, another watchdog is running; exit immediately.
2. **Hide console** — Win32 `ShowWindow` via PowerShell hides the terminal window.
3. **Load config** — reads `app.config.json` from auto-detected Vu One OS install directory to get `wallId` and `httpPort`.
4. **Start collectors** — background polling loops begin for system, network, and app metrics.
5. **Wait 3 seconds** — lets collectors populate their caches before first publish.
6. **Connect MQTT** — connects to the default broker (EMQX) via MQTTS. Subscribes to `watchdog/{wallId}/control` for remote commands.
7. **Start HTTP/WebSocket server** — serves dashboard on port 3200.
8. **Launch system tray** — PowerShell `NotifyIcon` in the Windows notification area.
9. **Start OSC listener** — UDP socket on configured port (default 1231).
10. **Open dashboard** — launches default browser to `http://localhost:3200`.
11. **Begin publish loop** — every 2 seconds, assembles a telemetry snapshot and publishes to MQTT + WebSocket.

## Install Path Detection

Vu One OS can be installed in two locations. The watchdog checks both in order and uses the first one where `app.config.json` exists:

1. `C:\Program Files (x86)\Vu One\Vu One_Data\StreamingAssets\Vu One`
2. `C:\Program Files (x86)\Vu One OS\Vu One_Data\StreamingAssets\Vu One`

The detected path is exported as `VUOS_DIR` and used to locate config files, lock files, and logs.

## Collectors

All collectors run background polling loops and cache their results. The main loop reads cached values every 2 seconds to assemble a snapshot.

### System Collector (`src/collectors/system.ts`)

| Metric | Source | Interval |
|--------|--------|----------|
| CPU usage % | `os.cpus()` tick deltas | 2s |
| CPU model, cores | `os.cpus()` | instant |
| RAM used/total | `os.totalmem()` / `os.freemem()` | instant |
| GPU name, usage, VRAM, temp | nvidia-smi or WMI | 5s |
| Disk used/total | PowerShell WMI | 60s |
| Disk I/O (read/write MB/s) | `Get-Counter PhysicalDisk` | 5s |
| Thermal throttling | `Get-Counter % Processor Performance` + GPU temp | 10s |
| Pending Windows updates | `Microsoft.Update.Session` COM | 5 min |
| Event log errors (1h) | `Get-WinEvent` Application Critical+Error | 60s |
| Uptime | `os.uptime()` | instant |

**GPU detection strategy** — on first poll, tries nvidia-smi. If that fails, falls back to PowerShell WMI queries (`Win32_VideoController`, `GPUPerformanceCounters`, `MSAcpi_ThermalZoneTemperature`). Once a strategy works, it locks in and stops probing.

**Thermal throttling** — detected when CPU processor performance drops below 95% (frequency scaling due to heat/power limits) or GPU temperature exceeds 90°C.

### Network Collector (`src/collectors/network.ts`)

| Metric | Source | Interval |
|--------|--------|----------|
| Internet online | HEAD `google.com/generate_204` | 10s |
| Latency (ms) | Round-trip time of above | 10s |
| Local server reachable | GET `localhost:{httpPort}/connected-users` | 3s |
| Connected peers | Array length from above | 3s |

### App Collector (`src/collectors/app.ts`)

| Metric | Source | Interval |
|--------|--------|----------|
| Vu One process running | PowerShell `Get-Process` | 5s |
| Vu One memory (MB) | `Get-Process` WorkingSet64 | 5s |
| Crash count today | PID change detection | 5s |
| Server process running | PowerShell `Get-Process` | 5s |
| Server version | `~/vu-one-server/package.json` | 60s |
| Lock file health | `VUOS_DIR/vu-server.lock` | instant |
| Recent error count | `VUOS_DIR/logs/error.log` tail | 10s |
| Last error message/time | `VUOS_DIR/logs/error.log` tail | 10s |

**Crash detection** — tracks the PID of `Vu One.exe`. If the process is running and the PID differs from the last known PID, a crash/restart is counted. The counter resets at midnight.

### OSC Listener (`src/collectors/osc.ts`)

- UDP socket on port from `system.config.json` `oscIp` field (default 1231)
- Parses OSC binary protocol (address + type tags + arguments)
- Supported types: int32, float32, string, boolean
- Filters out `/VuOne/ping` (heartbeat) and `/VuOne/userData` (sensitive data)
- Forwards all other commands to MQTT and WebSocket in real-time

## MQTT

### Broker Configuration

The watchdog connects to **one broker at a time** and can be switched live from the dashboard.

| Broker | Server URL | Dashboard WSS URL |
|--------|-----------|-------------------|
| **Vu Studio (EMQX)** (default) | `mqtts://c9b6cc55.ala.us-east-1.emqxsl.com:8883` | `wss://c9b6cc55.ala.us-east-1.emqxsl.com:8084/mqtt` |
| **Railway** | `mqtt://tramway.proxy.rlwy.net:20979` | `wss://mqtt.vu.studio/mqtt` |

All broker URLs and credentials are configurable via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MQTT_BROKER_URL` | `mqtts://...emqxsl.com:8883` | EMQX server URL |
| `MQTT_BROKER_WS_URL` | `wss://...emqxsl.com:8084/mqtt` | EMQX dashboard WSS URL |
| `MQTT_USERNAME` | `dev` | EMQX username |
| `MQTT_PASSWORD` | `testing` | EMQX password |
| `MQTT2_BROKER_URL` | `mqtt://tramway.proxy.rlwy.net:20979` | Railway server URL |
| `MQTT2_BROKER_WS_URL` | `wss://mqtt.vu.studio/mqtt` | Railway dashboard WSS URL |
| `MQTT2_USERNAME` | `dev` | Railway username |
| `MQTT2_PASSWORD` | `testing` | Railway password |

### Broker Switching

The dashboard has a **Broker dropdown** that triggers `POST /api/switch-broker` with `{brokerId: "emqx" | "railway"}`. The server:

1. Publishes offline status on the current broker
2. Disconnects from current broker
3. Connects to the new broker
4. Subscribes to control topic on the new broker
5. Broadcasts `broker-switched` event to all dashboard WebSocket clients

### MQTT Namespace Diagram

The EMQX broker is shared with Vu Studio. Each system uses its own top-level namespace:

```
EMQX Cloud Broker
│
├── player/{wallId}/              ← Vu Studio (existing)
│   ├── status                       online/offline
│   ├── commands                     playback, scene, asset control
│   ├── media                        media sync
│   └── ...
│
└── watchdog/{wallId}/            ← Vu Watchdog
    ├── telemetry                    system/network/app metrics (2s)
    ├── status                       online/offline (LWT)
    ├── config                       app + system config (60s)
    ├── commands                     OSC command stream (real-time)
    └── control                      inbound: restart-vuos, quit
```

Example for Wall ID `5538`:

```
watchdog/5538/telemetry   ← CPU 16%, RAM 62%, GPU 8%, disk 84%
watchdog/5538/status      ← {"status": "online", "wallId": "5538"}
watchdog/5538/config      ← {appConfig: {...}, systemConfig: {...}}
watchdog/5538/commands    ← {"address": "/VuOne/position", "args": [0.5]}
watchdog/5538/control     → {"action": "restart-vuos"}
```

Direction key:
- `←` published by watchdog (outbound)
- `→` received by watchdog (inbound)

### Topics

All topics use the namespace `watchdog/{wallId}/`:

| Topic | QoS | Retained | Interval | Content |
|-------|-----|----------|----------|---------|
| `watchdog/{wallId}/telemetry` | 0 | Yes | 2s | Full telemetry snapshot |
| `watchdog/{wallId}/status` | 1 | Yes | On connect/disconnect | `{status: "online"|"offline"}` |
| `watchdog/{wallId}/config` | 0 | Yes | 60s | app.config + system.config |
| `watchdog/{wallId}/commands` | 0 | No | Real-time | OSC commands from Vu One OS |
| `watchdog/{wallId}/control` | 1 | No | Inbound | Remote commands to watchdog |

### Last Will & Testament

On connection, the MQTT client registers a LWT message on `watchdog/{wallId}/status` with payload `{status: "offline"}`. If the watchdog crashes or loses connection, the broker automatically publishes this retained message so remote clients know the wall is offline.

### Control Topic

Subscribe to `watchdog/{wallId}/control` to send commands to the watchdog remotely:

```json
{"action": "restart-vuos"}   // Kill and relaunch Vu One.exe
{"action": "quit"}           // Exit the watchdog process
```

## HTTP Server (port 3200)

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Dashboard HTML |
| GET | `/ws` | WebSocket upgrade |
| POST | `/api/start-vuos` | Launch Vu One.exe (when not running) |
| POST | `/api/restart-vuos` | Kill and relaunch Vu One.exe |
| POST | `/api/switch-broker` | Switch MQTT broker `{brokerId}` |
| POST | `/api/quit` | Exit watchdog process |

### WebSocket Messages (server to client)

```json
{"type": "telemetry", "data": {...}}        // Every 2s
{"type": "config", "data": {...}}           // On connect + every 60s
{"type": "command", "data": {...}}          // Real-time OSC commands
{"type": "broker-switched", "data": {...}}  // After broker switch
```

## Dashboard

Single HTML file embedded in the executable at build time.

### Two Modes

**Local mode** — when accessed at `localhost:3200`:
- Connects via WebSocket (no MQTT in browser)
- Shows broker dropdown (switches server-side broker)
- Shows Start Vu OS (green, when not running) or Restart Vu OS (blue, when running) and Kill Watchdog buttons
- Hides Wall ID input and Connect button

**Remote mode** — when opened as a file or from another origin:
- Connects directly to MQTT broker via WSS
- Broker dropdown selects which broker to subscribe to
- Shows Wall ID input for targeting a specific wall
- No restart/kill buttons (read-only)

### Panels

- **System Health** — CPU, RAM, GPU, disk (usage + I/O), uptime with real-time charts
- **System Health (extended)** — thermal throttling, pending Windows updates, Windows Event Log errors (last hour)
- **Network Status** — internet connectivity, latency, local server, peers
- **Application Status** — process status, memory usage, crash count today, server version, lock file health, error log
- **OSC Command Log** — live stream of OSC messages from Vu One OS
- **Configuration Viewer** — app.config and system.config contents
- **Controls** — Start/Restart Vu OS (context-aware), broker switcher, Kill Watchdog

## System Tray

PowerShell-based `NotifyIcon` in the Windows notification area.

- **Icon**: extracted from `vu-watchdog.exe` itself
- **Tooltip**: "Vu Watchdog — Wall {wallId}"
- **Left-click**: open dashboard in browser
- **Right-click menu**:
  - Open Dashboard
  - Show Console
  - Quit

Communication between the tray and watchdog is via stdout — PowerShell writes `"open"`, `"show"`, or `"quit"` and the Bun process reads them.

## Build

```bash
bun run build    # Compile to vu-watchdog.exe + patch icon
bun run dev      # Development with watch mode
bun run start    # Run from source
```

The build compiles all TypeScript + embedded HTML into a single portable `.exe` via `bun build --compile`. The icon is patched afterward with `rcedit`.

### Dependencies

- **Runtime**: `mqtt` (MQTT 5.0 client)
- **Dev**: `@resvg/resvg-js` (SVG rendering), `rcedit` (exe icon patching), `@types/bun`

## Telemetry Payload Structure

```typescript
{
  timestamp: number;              // Unix ms
  wallId: string;
  system: {
    cpuUsage: number;             // percentage
    cpuModel: string;
    cpuCores: number;
    ramTotalMB: number;
    ramUsedMB: number;
    ramPercent: number;
    gpuName: string | null;
    gpuUsage: number | null;
    gpuMemUsedMB: number | null;
    gpuMemTotalMB: number | null;
    gpuTemp: number | null;       // Celsius
    diskTotalMB: number;
    diskUsedMB: number;
    diskPercent: number;
    diskReadMBps: number;         // MB/s
    diskWriteMBps: number;        // MB/s
    thermalThrottling: boolean;   // CPU perf < 95% or GPU > 90°C
    pendingUpdates: number;       // Windows updates waiting
    eventLog: {
      count: number;              // Critical+Error events in last hour
      lastMessage: string | null;
      lastTime: string | null;
    };
    uptime: number;               // seconds
  };
  network: {
    internetOnline: boolean;
    latencyMs: number | null;
    localServerReachable: boolean;
    connectedPeers: number;
  };
  app: {
    vuosProcessRunning: boolean;
    serverProcessRunning: boolean;
    serverVersion: string;
    vuosMemoryMB: number | null;  // Vu One.exe working set
    crashCountToday: number;      // PID change count since midnight
    serverLock: {
      pid: number;
      startTime: number;
      lastHeartbeat: number;
      heartbeatAgeMs: number;
      healthy: boolean;
    } | null;
    logs: {
      recentErrorCount: number;
      lastError: string | null;
      lastErrorTime: string | null;
    };
  };
}
```
