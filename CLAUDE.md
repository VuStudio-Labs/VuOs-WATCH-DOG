# CLAUDE.md — vu-watchdog

## What This Is

System health monitor for Vū One OS display walls. Collects hardware/software metrics, publishes them over MQTT, and serves a local real-time dashboard. Compiles to a single Windows `.exe` via Bun.

## Project Structure

```
vu-watchdog/
├── src/
│   ├── index.ts              # Entry point — orchestrates startup and telemetry loop
│   ├── server.ts             # Bun HTTP + WebSocket server (port 3200), serves dashboard
│   ├── mqtt.ts               # MQTT broker connection and publishing (creds via env vars)
│   ├── config.ts             # Reads app.config.json + system.config.json from VuOS install
│   ├── types.ts              # TypeScript interfaces for all telemetry payloads
│   ├── console.ts            # Hide/show console window via Win32 API (PowerShell)
│   ├── tray.ts               # System tray icon via PowerShell NotifyIcon
│   └── collectors/
│       ├── system.ts         # CPU, RAM, GPU (nvidia-smi), disk (PowerShell)
│       ├── network.ts        # Internet connectivity, latency, local server reachability
│       ├── app.ts            # Process checks, server lock file, error log parsing
│       └── osc.ts            # UDP OSC listener, binary protocol parser
├── scripts/
│   ├── build-ico.ts          # Converts logo.svg → logo.ico (multi-resolution)
│   └── set-icon.ts           # Patches exe icon via rcedit after compilation
├── index.html                # Dashboard UI (embedded into exe at build time)
├── logo.svg                  # Vu icon mark (used for favicon + exe icon)
├── logo-vustudio.svg         # Full Vū Studio wordmark (used in dashboard header)
├── logo.ico                  # Generated Windows icon (16/32/48/256px)
├── package.json
├── tsconfig.json
└── .gitignore
```

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │           index.ts (main)            │
                    │  snapshot() → telemetry every 2s     │
                    └──────┬──────────┬──────────┬─────────┘
                           │          │          │
               ┌───────────┘          │          └───────────┐
               ▼                      ▼                      ▼
        ┌─────────────┐     ┌──────────────────┐    ┌──────────────┐
        │  MQTT Broker │     │  server.ts       │    │  Collectors  │
        │  (remote)    │     │  localhost:3200   │    │              │
        │              │     │  /ws  → WebSocket │    │  system (2s) │
        │  Topics:     │     │  /    → dashboard │    │  network(10s)│
        │  telemetry   │     │                   │    │  app    (5s) │
        │  commands    │     │  Receives same    │    │  osc  (live) │
        │  config      │     │  data as MQTT     │    └──────────────┘
        │  health      │     └──────────────────┘
        └─────────────┘
```

### Data Flow

1. **Collectors** poll hardware/software at varying intervals, cache results
2. **index.ts** calls `snapshot()` every 2s, assembling cached collector data
3. Snapshot is published to both **MQTT** (remote) and **local WebSocket** (dashboard)
4. **OSC commands** arrive on UDP port 1231, forwarded to both MQTT and WebSocket
5. **Config** (app + system config files) published on connect + every 60s

### Communication

| Protocol  | Port/Address                      | Purpose                          |
|-----------|-----------------------------------|----------------------------------|
| MQTT      | `tramway.proxy.rlwy.net:20979`    | Remote telemetry pub/sub         |
| WebSocket | `localhost:3200/ws`               | Local dashboard real-time feed   |
| HTTP      | `localhost:3200`                  | Dashboard UI                     |
| OSC/UDP   | `0.0.0.0:1231`                   | Inbound commands from Vu One     |
| HTTP      | `localhost:{httpPort}`            | Vu One server API (read-only)    |

### MQTT Topics

```
vu/{wallId}/telemetry        # Full snapshot (retained, QoS 0, every 2s)
vu/{wallId}/telemetry/health # Online/offline status (retained, QoS 1, LWT)
vu/{wallId}/commands         # OSC commands (non-retained, QoS 0, real-time)
vu/{wallId}/config           # App + system config (retained, QoS 0, every 60s)
```

### WebSocket Message Format

```jsonc
// Telemetry (every 2s)
{ "type": "telemetry", "data": { ...TelemetryPayload } }

// OSC command (real-time)
{ "type": "command", "data": { "timestamp": 1234, "address": "/VuOne/position", "args": [0.5, 0.5] } }

// Config (on connect + every 60s)
{ "type": "config", "data": { "appConfig": {...}, "systemConfig": {...} } }
```

## Collector Details

### system.ts
- **CPU**: Samples `os.cpus()` every 2s, calculates usage from idle/total tick deltas
- **GPU**: Spawns `nvidia-smi` every 5s — name, usage%, VRAM, temperature
- **Disk**: PowerShell `Get-CimInstance Win32_LogicalDisk` every 60s, aggregates all fixed drives
- **RAM**: Instant from `os.totalmem()` / `os.freemem()`
- **Uptime**: `os.uptime()`

### network.ts
- **Internet**: HEAD to `google.com/generate_204` every 10s, measures latency
- **Local server**: GET `localhost:{httpPort}/connected-users` every 3s, counts peers

### app.ts
- **Processes**: PowerShell `Get-Process` for "Vu One" and "Vu_OS_Server*" every 5s
- **Lock file**: Reads `vu-server.lock` JSON — pid, startTime, lastHeartbeat. Healthy if heartbeat < 10s old
- **Error log**: Reads last 8KB of `error.log` every 10s, extracts timestamped errors
- **Server version**: Reads `~/vu-one-server/package.json` every 60s

### osc.ts
- Listens on UDP port 1231
- Parses binary OSC protocol (4-byte aligned strings, type tags: i/f/s/T/F)
- Filters out `/VuOne/ping` and `/VuOne/userData`
- Forwards parsed commands to MQTT + optional callback (dashboard)

## Key Paths (Windows)

```
C:\Program Files (x86)\Vu One OS\Vu One_Data\StreamingAssets\Vu One\
├── app.config.json          # wallId, websocketPort, httpPort
├── system.config.json       # displays, processorMode, oscIp, etc.
├── vu-server.lock           # Server process health (JSON: pid, heartbeat)
└── logs\error.log           # Application error log
```

## Commands

```bash
bun run dev       # Development with hot reload
bun run start     # Run directly
bun run build     # Compile to vu-watchdog.exe + set icon
```

### Build Pipeline

1. `bun build --compile src/index.ts --outfile vu-watchdog.exe` — bundles all TS + `index.html` into single exe
2. `bun scripts/set-icon.ts` — patches Vu logo into exe via rcedit

### Regenerating the Icon

If `logo.svg` changes:
```bash
bun scripts/build-ico.ts    # Regenerates logo.ico from logo.svg
bun run build               # Rebuild exe with new icon
```

## Dashboard (index.html)

Single-file HTML dashboard with inline CSS/JS (no build step). Two connection modes:

- **Local mode** (port 3200): Auto-connects to `ws://localhost:3200/ws`, hides MQTT controls. Used when served from the watchdog exe.
- **MQTT mode** (any other origin): Connects to remote MQTT broker via `wss://mqtt.vu.studio/mqtt`. Used when opened directly as a file or from another server.

### External Dependencies (CDN)
- Chart.js 4.4.1 — time-series charts
- date-fns 3.3.1 + chartjs-adapter — date axis formatting
- mqtt.js 4.3.7 — browser MQTT client (only used in MQTT mode)

## Type Interfaces

The `TelemetryPayload` is the core data structure:

```typescript
TelemetryPayload {
  timestamp: number
  wallId: string
  system: SystemMetrics    // cpu, ram, gpu, disk, uptime
  network: NetworkMetrics  // online, latency, server reachable, peers
  app: AppMetrics          // processes, server version, lock health, logs
}
```

See `src/types.ts` for full field definitions.

## Releasing

When creating a new release:

1. **Always check existing versions first**:
   ```bash
   gh release list
   ```

2. **Increment from the latest version** (currently using semver v2.x.x)

3. **Build and release**:
   ```bash
   bun run build
   gh release create v2.3.X vu-watchdog.zip --title "v2.3.X - Description" --notes "..."
   ```

4. **Never guess the version** — always look at `gh release list` first!

## Important Notes

- **Windows-only**: Uses PowerShell for system queries, nvidia-smi for GPU, Windows paths
- **Bun runtime**: Not Node.js — uses Bun APIs (`Bun.serve`, `Bun.spawn`, `import with { type: "text" }`)
- **Single exe**: `index.html` is embedded at compile time via Bun's text import, not read from disk
- **Graceful degradation**: Missing GPU, unreachable server, absent log files — all handled silently
- **MQTT credentials**: Read from env vars (`MQTT_BROKER_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`) with fallback defaults; never exposed in static HTML
- **System tray**: Runs minimized to tray on Windows via PowerShell NotifyIcon; icon extracted from exe
- **Kill endpoint**: `POST /api/quit` shuts down the watchdog; dashboard has a "Kill Watchdog" button (local mode only)
- **No authentication**: Dashboard server has no auth — only binds to localhost
