# vu-watchdog

Standalone system watchdog for Vu One OS installations. Collects hardware telemetry, network health, application state, and live command data, then publishes everything to an external MQTT broker for remote monitoring.

## Architecture

```
+------------------+       +---------------+       +-------------------+
|   Vu One OS      |       |  vu-watchdog  |       |   MQTT Broker     |
|   (Unity app)    |       |   (Bun)       |       |   (Railway)       |
|                  |       |               |       |                   |
|  OSC output ----UDP----> | osc listener  | ----> | vu/{id}/commands  |
|  vu-server.lock -file--> | lock reader   | ----> | vu/{id}/telemetry |
|  app.config.json -file-> | config reader | ----> | vu/{id}/config    |
|  system.config   -file-> |               |       | vu/{id}/telemetry |
|  error.log ------file--> | log parser    |       |   /health         |
|                  |       |               |       |                   |
|  vu-one-server   |       | system polls  |       |                   |
|  /connected-users|--HTTP>| network check |       |                   |
+------------------+       +---------------+       +-------------------+
                               |      |
                          os.cpus()  nvidia-smi
                          os.totalmem() PowerShell
```

## Requirements

- [Bun](https://bun.sh) runtime
- Windows (uses PowerShell and nvidia-smi for metrics)
- Vu One OS installed at `C:\Program Files (x86)\Vu One OS`
- Network access to the MQTT broker

## Setup

```bash
cd vu-watchdog
bun install
```

## Usage

```bash
# Development (auto-reload on changes)
bun run dev

# Production
bun run start
```

## MQTT Broker

Connects to a dedicated telemetry broker (separate from Vu Studio's MQTT):

| Field    | Value                              |
|----------|------------------------------------|
| Protocol | `mqtt://` (TCP)                    |
| Host     | `tramway.proxy.rlwy.net`           |
| Port     | `20979`                            |
| Username | `dev`                              |
| Password | `testing`                          |

## MQTT Topics

| Topic                          | Retained | Interval  | Description                         |
|--------------------------------|----------|-----------|-------------------------------------|
| `vu/{wallId}/telemetry`        | Yes      | 2s        | Full system/network/app metrics     |
| `vu/{wallId}/telemetry/health` | Yes      | On event  | Online/offline status (LWT)         |
| `vu/{wallId}/commands`         | No       | Realtime  | OSC command stream from VuOS        |
| `vu/{wallId}/config`           | Yes      | 60s       | app.config.json + system.config.json|

### Retained vs Non-Retained

- **Retained** topics store the last message on the broker. New subscribers immediately receive the most recent value on connect without waiting for the next publish cycle.
- **Non-retained** topics (`commands`) are ephemeral events. Subscribers only see messages that arrive after they connect.

## Telemetry Payload

Published to `vu/{wallId}/telemetry` every 2 seconds:

```jsonc
{
  "timestamp": 1769739244905,
  "wallId": "5538",
  "system": {
    "cpuUsage": 19.1,           // % (rolling delta, sampled every 2s)
    "cpuModel": "Intel(R) Core(TM) Ultra 9 185H",
    "cpuCores": 22,
    "ramTotalMB": 32116,
    "ramUsedMB": 16538,
    "ramPercent": 51.5,
    "gpuName": "NVIDIA GeForce RTX 4070 Laptop GPU",  // null if no NVIDIA GPU
    "gpuUsage": 38,             // % (refreshed every 5s via nvidia-smi)
    "gpuMemUsedMB": 2892,
    "gpuMemTotalMB": 8188,
    "gpuTemp": 54,              // Celsius
    "diskTotalMB": 975461,      // all drives combined (refreshed every 60s)
    "diskUsedMB": 808953,
    "diskPercent": 82.9,
    "uptime": 304764            // OS uptime in seconds
  },
  "network": {
    "internetOnline": true,     // HEAD google.com/204 (refreshed every 10s)
    "latencyMs": 53,            // round-trip to google
    "localServerReachable": true, // localhost:{httpPort}/connected-users (refreshed every 3s)
    "connectedPeers": 1         // count of remote clients connected to vu-one-server
  },
  "app": {
    "vuosProcessRunning": true,   // "Vu One" process (refreshed every 5s)
    "serverProcessRunning": true, // "Vu_OS_Server*" process (refreshed every 5s)
    "serverVersion": "2026.1.5",  // from vu-one-server/package.json (refreshed every 60s)
    "serverLock": {               // from vu-server.lock (read every 2s)
      "pid": 35060,               // server process ID
      "startTime": 1769733828894, // epoch ms when server started
      "lastHeartbeat": 1769739244593, // epoch ms of last lock file write
      "heartbeatAgeMs": 313,      // how stale the heartbeat is
      "healthy": true             // true if heartbeat < 10s old
    },
    "logs": {                     // tail of error.log (refreshed every 10s)
      "recentErrorCount": 10,     // error entries in last 8KB of log
      "lastError": "Error on WebRTC connection: ...",
      "lastErrorTime": "2026-01-24 03:11:58.1158"
    }
  }
}
```

## Commands Payload

Published to `vu/{wallId}/commands` in realtime as OSC messages arrive:

```jsonc
{
  "timestamp": 1769739300000,
  "address": "/VuOne/position",
  "args": [0.516, 0.5]
}
```

### Known OSC Addresses

| Address               | Args                  | Description                        |
|-----------------------|-----------------------|------------------------------------|
| `/VuOne/ping`         | (none)                | Heartbeat (filtered out, not sent) |
| `/VuOne/userData`     | [json string]         | Full user profile on connect       |
| `/VuOne/connectioninfo` | [string]           | Connection code                    |
| `/VuOne/selectAsset`  | [asset UUID]          | Asset selected on display          |
| `/VuOne/masterVolume` | [float]               | Volume level change                |
| `/VuOne/position`     | [x, y]                | Asset position (realtime drag)     |
| `/VuOne/blur`         | [float]               | Blur amount adjustment             |

Large string arguments (>500 chars) are truncated to keep MQTT payloads small.

## Config Payload

Published to `vu/{wallId}/config` on startup and every 60 seconds:

```jsonc
{
  "appConfig": {
    "wallId": "5538",
    "websocketPort": 53691,
    "httpPort": 53693
  },
  "systemConfig": {
    "processorMode": "Brompton",
    "wallIP": "10.101.50.250:80",
    "displays": [
      {
        "nickname": "LG HDR 4K",
        "hardwareName": "LG HDR 4K",
        "systemWidth": 3740,
        "systemHeight": 1971,
        "renderWidth": 3740,
        "renderHeight": 1971,
        "isFullscreen": false,
        "isActivated": true,
        "displayMode": "Asset",
        "displayedAssets": [
          {
            "id": "e5170e98-...",
            "title": "ComfyUI_03249_",
            "type": "image/png",
            "filenameDownload": "ComfyUI_03249_.png"
          }
        ]
        // ... other display fields
      }
    ],
    "oscIp": "10.150.10.201:1231",
    "networkAdapter": "10.150.10.201",
    "uiSettings": {
      "currentVersion": "2026.1.28-D",
      "welcomeMessage": "Welcome to Vu Studio",
      "showQR": true,
      "showTime": true
      // ...
    }
  }
}
```

Asset URLs (src, thumbnails, downloadLink) are stripped from `displayedAssets` to keep the payload small. Only `id`, `title`, `type`, and `filenameDownload` are included.

## Health / LWT

The watchdog uses MQTT Last Will and Testament (LWT) for automatic offline detection:

- **On connect**: publishes `{ "status": "online", "wallId": "5538", "timestamp": ... }` to `vu/{wallId}/telemetry/health` (retained)
- **On unexpected disconnect**: the broker automatically publishes `{ "status": "offline", ... }` (retained)
- New subscribers immediately know if the watchdog is alive or dead.

## Background Polling

To achieve 2-second publish intervals without blocking, slow collectors run on independent background timers and cache their results. The main publish loop reads from cache.

| Collector         | Interval | Method                                      |
|-------------------|----------|---------------------------------------------|
| CPU usage         | 2s       | `os.cpus()` delta (non-blocking)            |
| RAM               | 2s       | `os.totalmem()` / `os.freemem()` (instant)  |
| GPU               | 5s       | `nvidia-smi` subprocess                     |
| Disk              | 60s      | PowerShell `Get-CimInstance Win32_LogicalDisk` |
| Internet ping     | 10s      | `fetch` HEAD to google.com/204              |
| Local server      | 3s       | `fetch` to localhost/connected-users        |
| Process checks    | 5s       | PowerShell `Get-Process`                    |
| Error log         | 10s      | `fs.read` tail of error.log                |
| Server lock       | 2s       | `fs.readFileSync` (instant)                 |
| Server version    | 60s      | `fs.readFileSync` package.json              |
| Config files      | 60s      | `fs.readFileSync` both config JSONs         |
| OSC commands      | realtime | UDP socket on port 1231                     |

## Project Structure

```
vu-watchdog/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts              # Entry point, polling init, MQTT connect, publish loop
│   ├── config.ts             # Load wallId/ports from VuOS app.config.json + system.config.json
│   ├── mqtt.ts               # MQTT client, connect, publish, LWT, topic definitions
│   ├── types.ts              # TypeScript interfaces for all payloads
│   └── collectors/
│       ├── system.ts         # CPU, RAM, GPU (nvidia-smi), disk (PowerShell), uptime
│       ├── network.ts        # Internet check + latency, local server probe + peer count
│       ├── app.ts            # Process detection, server version, lock file, error log
│       └── osc.ts            # UDP listener, OSC binary parser, MQTT command forwarding
```

## Dependencies

| Package | Purpose            |
|---------|--------------------|
| `mqtt`  | MQTT client (only external dependency) |

Everything else uses Bun/Node builtins: `os`, `fs`, `dgram`, `fetch`, `Bun.spawn`.

## Testing

Subscribe to the watchdog topics using any MQTT client:

```bash
# Using mosquitto_sub
mosquitto_sub -h tramway.proxy.rlwy.net -p 20979 -u dev -P testing -t "vu/5538/#" -v
```

### Verification Checklist

1. Start watchdog: `bun run start`
2. Subscribe to `vu/5538/telemetry` -- payloads arrive every 2s
3. Subscribe to `vu/5538/config` -- config payload arrives immediately (retained)
4. Send a command from a remote Vu Studio client -- appears on `vu/5538/commands`
5. Kill `Vu One.exe` -- next telemetry shows `vuosProcessRunning: false`
6. Kill vu-one-server -- `serverLock.healthy` becomes `false` after 10s
7. Kill the watchdog -- broker fires LWT: `{ "status": "offline" }` on health topic
8. Restart watchdog -- health topic updates to `{ "status": "online" }`
