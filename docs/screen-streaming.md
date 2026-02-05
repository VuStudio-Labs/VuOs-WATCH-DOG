# Screen Streaming

Stream the display wall's desktop to any web browser in real-time using WebRTC.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                 Display Wall PC                  │
│                                                  │
│  Watchdog (port 3200)                            │
│    │  manages lifecycle (start/stop/status)       │
│    ▼                                             │
│  webrtc-streamer.exe (port 8000)                 │
│    ├─ Screen capture via Desktop Duplication API  │
│    ├─ H.264 encoding                             │
│    ├─ HTTP signaling server                      │
│    ├─ Embedded STUN server (NAT discovery)       │
│    └─ Embedded TURN server (relay fallback)      │
└─────────────────────┬────────────────────────────┘
                      │ WebRTC (P2P or TURN relay)
                      ▼
              Browser Viewer
         (any device, anywhere)
```

## How It Works

### Screen Capture

The streaming uses [webrtc-streamer](https://github.com/mpromonet/webrtc-streamer), a single prebuilt binary that captures the Windows desktop using the **Desktop Duplication API** (DXGI). This captures directly from the GPU framebuffer, including fullscreen applications, overlays, and hardware-accelerated content.

The captured frames are encoded to **H.264** in real-time and delivered via **WebRTC**.

### WebRTC Connection Flow

1. Viewer opens the viewer URL in a browser
2. Browser fetches an SDP offer from the HTTP signaling server (port 8000)
3. **ICE candidates** are gathered using STUN to discover public IPs
4. WebRTC attempts a **direct P2P connection** between the wall PC and the viewer
5. If P2P fails (symmetric NAT, firewall), traffic relays through the **embedded TURN server**
6. Video streams with **100-500ms latency**

### NAT Traversal

| Method | Purpose | Success Rate |
|--------|---------|-------------|
| **Direct P2P** | No relay, lowest latency | ~60% of connections |
| **STUN** | Discovers public IP, enables P2P through NAT | ~80% of connections |
| **TURN** | Relays traffic when P2P fails | 100% (fallback) |

The embedded TURN server runs on the wall PC (port 3478/UDP), so for fully remote access, this port must also be reachable (or use a tunnel).

---

## Setup

### 1. Install webrtc-streamer

```bash
bun scripts/download-webrtc-streamer.ts
```

This downloads the Windows binary (~20MB) and web player files to `bin/`.

### 2. Verify Installation

```bash
curl http://localhost:3200/api/stream-status
```

Response should include `"available": true`:

```json
{
  "status": "stopped",
  "pid": null,
  "port": 8000,
  "startedAt": null,
  "viewerUrl": null,
  "error": null,
  "available": true
}
```

---

## Usage

### Start Streaming

**Via Dashboard:**
1. Open `http://localhost:3200`
2. Find the **Screen Streaming** card
3. Click **Start Stream**
4. Click **Open Viewer** to watch

**Via API:**

```bash
# Start
curl -X POST http://localhost:3200/api/stream-start

# Response
{
  "ok": true,
  "state": {
    "status": "running",
    "pid": 12345,
    "port": 8000,
    "startedAt": 1770159614257,
    "viewerUrl": "http://localhost:8000/webrtcstreamer.html?video=desktop"
  }
}
```

### Stop Streaming

**Via Dashboard:** Click **Stop Stream**

**Via API:**

```bash
curl -X POST http://localhost:3200/api/stream-stop
```

### Check Status

```bash
curl http://localhost:3200/api/stream-status
```

---

## Viewer URL

Once streaming is active, the viewer is available at:

```
http://<wall-ip>:8000/webrtcstreamer.html?video=desktop
```

Replace `<wall-ip>` with the wall PC's IP address. On the same machine, use `localhost`.

The viewer page is a built-in web player that:
- Connects to the WebRTC stream automatically
- Renders video in a `<video>` element
- Handles reconnection on network interruption
- Works in any modern browser (Chrome, Firefox, Edge, Safari)

---

## Remote Access

### Same LAN

No additional setup needed. Use the wall PC's local IP:

```
http://192.168.1.100:8000/webrtcstreamer.html?video=desktop
```

### Remote (Outside LAN)

The viewer needs to reach port **8000** (HTTP signaling) on the wall PC. Options:

#### Option 1: Cloudflare Tunnel (Recommended)

Free, secure, no port forwarding.

```bash
# Install cloudflared
winget install Cloudflare.cloudflared

# Create tunnel
cloudflared tunnel --url http://localhost:8000
```

Share the generated `https://xxx.trycloudflare.com` URL.

#### Option 2: ngrok

Quick temporary URL for testing.

```bash
# Install ngrok
winget install ngrok.ngrok

# Create tunnel
ngrok http 8000
```

Share the generated `https://xxx.ngrok-free.app` URL.

#### Option 3: Tailscale

Secure mesh VPN between devices. Both sides need Tailscale installed.

```bash
# Install Tailscale on wall PC and viewer device
# Then use Tailscale IP
http://<tailscale-ip>:8000/webrtcstreamer.html?video=desktop
```

#### Option 4: Port Forwarding

Forward port **8000** (TCP) on your router to the wall PC. Optionally also forward port **3478** (UDP) for TURN relay.

```
http://<public-ip>:8000/webrtcstreamer.html?video=desktop
```

---

## Ports

| Port | Protocol | Purpose | Required |
|------|----------|---------|----------|
| **3200** | TCP | Watchdog dashboard & API | Always |
| **8000** | TCP | webrtc-streamer HTTP (signaling + viewer) | When streaming |
| **3478** | UDP | Embedded TURN server (relay) | For remote through strict NAT |
| Dynamic | UDP | WebRTC media (P2P) | Automatic via ICE |

---

## Configuration

Default configuration in `src/streaming.ts`:

```typescript
const DEFAULT_CONFIG: StreamingConfig = {
  port: 8000,                              // HTTP server port
  stunServer: "stun:stun.l.google.com:19302",  // Google's free STUN
  enableTurn: true,                         // Embedded TURN server
  turnPort: 3478,                           // TURN server port
};
```

### webrtc-streamer CLI Options

The watchdog spawns webrtc-streamer with:

```
webrtc-streamer.exe \
  -H 0.0.0.0:8000           # HTTP binding (all interfaces)
  -w bin/html                # Web root for viewer page
  -s stun:stun.l.google.com:19302  # STUN server
  -T turn:turn@0.0.0.0:3478 # Embedded TURN server
  -n desktop                 # Stream name
  -u screen://               # Capture source (desktop)
```

Additional options (can be added to streaming.ts):

| Flag | Description |
|------|-------------|
| `-m <n>` | Maximum peer connections (viewers) |
| `-c <path>` | TLS cert for HTTPS |
| `-R <min>:<max>` | UDP port range for WebRTC |
| `-a` | Enable audio capture |
| `-o` | Null codec (keep hardware encoding) |

---

## API Reference

### `POST /api/stream-start`

Start screen capture streaming.

**Response:**
```json
{
  "ok": true,
  "state": {
    "status": "running",
    "pid": 12345,
    "port": 8000,
    "startedAt": 1770159614257,
    "viewerUrl": "http://localhost:8000/webrtcstreamer.html?video=desktop"
  }
}
```

### `POST /api/stream-stop`

Stop streaming and kill the webrtc-streamer process.

**Response:**
```json
{
  "ok": true,
  "state": {
    "status": "stopped",
    "pid": null,
    "port": 8000,
    "startedAt": null,
    "viewerUrl": null
  }
}
```

### `GET /api/stream-status`

Get current streaming state.

**Response:**
```json
{
  "status": "running",
  "pid": 12345,
  "port": 8000,
  "startedAt": 1770159614257,
  "viewerUrl": "http://localhost:8000/webrtcstreamer.html?video=desktop",
  "error": null,
  "available": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | `stopped`, `starting`, `running`, or `error` |
| `pid` | number | webrtc-streamer process ID |
| `port` | number | HTTP server port |
| `startedAt` | number | Unix timestamp when streaming started |
| `viewerUrl` | string | URL to open the viewer |
| `error` | string | Error message if status is `error` |
| `available` | boolean | Whether webrtc-streamer binary is installed |

---

## WebSocket Events

The watchdog broadcasts streaming state changes over WebSocket:

```json
{
  "type": "streaming",
  "data": {
    "status": "running",
    "pid": 12345,
    "port": 8000,
    "startedAt": 1770159614257,
    "viewerUrl": "http://localhost:8000/webrtcstreamer.html?video=desktop",
    "available": true
  }
}
```

Sent on:
- WebSocket connect (initial state)
- Stream start
- Stream stop

---

## MQTT Namespace

Streaming state is included in the telemetry payload under the `streaming` key when integrated with the main telemetry loop:

```
watchdog/{wallId}/telemetry → { ..., streaming: StreamingState }
```

UNS mirror:
```
vu/v1/asset/wall/{wallId}/watchdog/telemetry/system → { ..., streaming: StreamingState }
```

---

## Troubleshooting

### "webrtc-streamer not installed"

Run the download script:
```bash
bun scripts/download-webrtc-streamer.ts
```

### Stream starts but viewer shows black screen

- Check if the desktop is active (not locked/sleeping)
- Try refreshing the viewer page
- Check if another screen capture tool is running (some conflict with DXGI)

### Remote viewer can't connect

1. Verify port 8000 is reachable: `curl http://<wall-ip>:8000/`
2. Check firewall allows port 8000 (TCP) and 3478 (UDP)
3. Use a tunnel (cloudflared/ngrok) if port forwarding isn't possible

### High latency

- Ensure STUN is working (check browser console for ICE candidates)
- If using TURN relay, latency will be higher than P2P
- Reduce resolution or framerate in the capture config

### Multiple viewers

webrtc-streamer supports multiple simultaneous viewers. Each viewer gets its own WebRTC peer connection. Performance depends on the wall PC's CPU/GPU and upload bandwidth.

---

## Files

| File | Purpose |
|------|---------|
| `src/streaming.ts` | Process management (start/stop/status) |
| `src/server.ts` | HTTP API endpoints for streaming |
| `index.html` | Dashboard UI with streaming controls |
| `bin/webrtc-streamer.exe` | Prebuilt streaming binary (gitignored) |
| `bin/html/` | Built-in web viewer files (gitignored) |
| `scripts/download-webrtc-streamer.ts` | Binary download script |

---

## Dependencies

- **webrtc-streamer v0.8.14** — [github.com/mpromonet/webrtc-streamer](https://github.com/mpromonet/webrtc-streamer) (BSD-2-Clause license)
- No npm dependencies added — streaming is managed via process spawning
