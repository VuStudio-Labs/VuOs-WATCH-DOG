# vu-watchdog

System health monitor and watchdog for [Vu One OS](https://vu.studio) display wall installations. Collects hardware telemetry, network health, and application state, then publishes everything over MQTT for remote monitoring. Includes a local real-time dashboard and runs minimized to the Windows system tray.

Compiles to a single portable `.exe` via [Bun](https://bun.sh).

![Dashboard](docs/dashboard.png)

## Features

- **Real-time telemetry** — CPU, RAM, GPU (NVIDIA), disk, network latency, process health
- **MQTT publishing** — All metrics published to a remote broker for cloud dashboards
- **Local dashboard** — Browser-based UI at `http://localhost:3200` with live charts
- **System tray** — Runs minimized; tray icon for dashboard access, console toggle, and quit
- **OSC listener** — Receives Open Sound Control commands from Vu One and forwards them
- **Last Will & Testament** — Automatic online/offline detection via MQTT LWT
- **Single exe** — Everything bundled into one Windows executable

## Requirements

- Windows 10/11
- [Bun](https://bun.sh) (for development; not needed to run the compiled exe)
- Vu One OS installed at `C:\Program Files (x86)\Vu One OS`
- Network access to the MQTT broker

## Getting Started

```bash
# Install dependencies
bun install

# Development (auto-reload)
bun run dev

# Production
bun run start

# Build standalone exe
bun run build
```

## Configuration

The watchdog reads configuration from the Vu One OS installation:

| File | Location | Contents |
|------|----------|----------|
| `app.config.json` | `Vu One_Data/StreamingAssets/Vu One/` | `wallId`, `websocketPort`, `httpPort` |
| `system.config.json` | `Vu One_Data/StreamingAssets/Vu One/` | Display layout, network, UI settings |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MQTT_BROKER_URL` | `mqtt://tramway.proxy.rlwy.net:20979` | MQTT broker TCP URL |
| `MQTT_BROKER_WS_URL` | `wss://mqtt.vu.studio/mqtt` | MQTT broker WebSocket URL (for dashboard) |
| `MQTT_USERNAME` | `dev` | Broker username |
| `MQTT_PASSWORD` | `testing` | Broker password |

## Architecture

```
+------------------+       +---------------+       +-------------------+
|   Vu One OS      |       |  vu-watchdog  |       |   MQTT Broker     |
|   (Unity app)    |       |               |       |                   |
|                  |       |  collectors   |       |                   |
|  OSC output ----UDP----> |  osc listener | ----> | vu/{id}/commands  |
|  config files --file---> |  config reader| ----> | vu/{id}/config    |
|  error.log -----file---> |  log parser   | ----> | vu/{id}/telemetry |
|  vu-server.lock -file--> |  lock reader  |       | vu/{id}/health    |
|  /connected-users HTTP-> |  network check|       |                   |
+------------------+       +-------+-------+       +-------------------+
                                   |
                           +-------+-------+
                           |  Dashboard    |
                           |  :3200        |
                           |  WebSocket+UI |
                           +-------+-------+
                                   |
                           +-------+-------+
                           |  System Tray  |
                           |  (NotifyIcon) |
                           +---------------+
```

## MQTT Topics

| Topic | Retained | Interval | Description |
|-------|----------|----------|-------------|
| `vu/{wallId}/telemetry` | Yes | 2s | Full system/network/app metrics |
| `vu/{wallId}/telemetry/health` | Yes | On event | Online/offline status (LWT) |
| `vu/{wallId}/commands` | No | Realtime | OSC command stream from Vu One |
| `vu/{wallId}/config` | Yes | 60s | App + system configuration |

## Dashboard

The built-in dashboard at `http://localhost:3200` provides:

- Live CPU, RAM, GPU, and disk usage charts
- Network connectivity and latency monitoring
- Application process status
- OSC command log
- Configuration viewer
- **Kill Watchdog** button for remote shutdown

When accessed locally (port 3200), it connects via WebSocket. When hosted elsewhere, it falls back to MQTT over WebSocket.

## System Tray

On Windows, the watchdog starts minimized to the notification area:

- **Left-click** — Opens the dashboard in your default browser
- **Right-click menu:**
  - Open Dashboard
  - Show Console
  - Quit

## Project Structure

```
vu-watchdog/
├── src/
│   ├── index.ts          # Entry point, startup orchestration
│   ├── server.ts         # HTTP + WebSocket server (port 3200)
│   ├── mqtt.ts           # MQTT broker connection and publishing
│   ├── config.ts         # Reads Vu One OS config files
│   ├── types.ts          # TypeScript interfaces
│   ├── console.ts        # Win32 console show/hide
│   ├── tray.ts           # System tray via PowerShell NotifyIcon
│   └── collectors/
│       ├── system.ts     # CPU, RAM, GPU, disk, uptime
│       ├── network.ts    # Internet check, latency, local server
│       ├── app.ts        # Process detection, server lock, error log
│       └── osc.ts        # UDP OSC listener and parser
├── index.html            # Dashboard UI (embedded at build time)
├── logo.svg              # Source icon
├── logo.ico              # Windows icon (16/32/48/256px)
├── scripts/
│   ├── build-ico.ts      # SVG to ICO converter
│   └── set-icon.ts       # Patches exe icon via rcedit
├── package.json
└── tsconfig.json
```

## Build

```bash
bun run build
```

This runs two steps:
1. `bun build --compile` — Bundles all TypeScript + HTML into a single `vu-watchdog.exe`
2. `scripts/set-icon.ts` — Patches the Vu logo icon onto the exe via rcedit

### Regenerating the Icon

```bash
bun scripts/build-ico.ts   # logo.svg -> logo.ico
bun run build               # Rebuild exe with new icon
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `mqtt` | MQTT 5.0 client |

Dev dependencies: `@resvg/resvg-js` (SVG rendering), `rcedit` (exe icon patching), `@types/bun`.

## License

Proprietary. All rights reserved.

## Author

**Alvin Renz Teves**

Vu Labs — Research & Development
[vu.studio](https://vu.studio)
