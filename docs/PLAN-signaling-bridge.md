# Plan: VDO.ninja Signaling Bridge

## Goal

Enable **remote screen viewing without port forwarding** by bridging webrtc-streamer's HTTP API to VDO.ninja's public WebSocket signaling infrastructure.

## Current State

- **webrtc-streamer** running on port 8000, handles screen capture + WebRTC
- Works locally, but remote access requires port forwarding or tunnels
- webrtc-streamer has an HTTP API for WebRTC signaling

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Display Wall PC                                   │
│                                                                             │
│  ┌─────────────────┐      ┌─────────────────┐      ┌───────────────────┐   │
│  │ webrtc-streamer │◄────►│ Signaling Bridge│◄────►│  VDO.ninja WSS    │   │
│  │   (port 8000)   │ HTTP │  (Bun module)   │  WS  │ (api.vdo.ninja)   │   │
│  │                 │      │                 │      │                   │   │
│  │  Screen Capture │      │  SDP/ICE Proxy  │      │  Room: wall-{id}  │   │
│  │  WebRTC Engine  │      │                 │      │                   │   │
│  └─────────────────┘      └─────────────────┘      └─────────┬─────────┘   │
│                                                               │             │
└───────────────────────────────────────────────────────────────┼─────────────┘
                                                                │
                                        (VDO.ninja handles NAT traversal)
                                                                │
                                                                ▼
                                                    ┌───────────────────┐
                                                    │   Remote Viewer   │
                                                    │ vdo.ninja/?view=  │
                                                    │    wall-{id}      │
                                                    └───────────────────┘
```

## Key Insight

**webrtc-streamer already handles all the WebRTC complexity** (ICE, DTLS, SRTP, media encoding). We just need to:

1. Get SDP offer from webrtc-streamer
2. Send it to remote viewer via VDO.ninja's signaling
3. Get SDP answer back from viewer
4. Pass ICE candidates both ways

VDO.ninja's public servers handle:
- WebSocket signaling (relay SDP/ICE between peers)
- STUN (NAT discovery)
- TURN (relay when P2P fails)

---

## VDO.ninja Signaling Protocol

Based on analysis of VDO.ninja's codebase:

### Connection Flow

```
Publisher (Bridge)                 VDO.ninja WSS                    Viewer (Browser)
       │                               │                                  │
       │── connect wss://vdo.ninja ───►│                                  │
       │── {"join":"room-id"} ────────►│                                  │
       │                               │◄── {"join":"room-id"} ───────────│
       │                               │                                  │
       │◄── {"request":"offer"} ───────│  (viewer requests stream)        │
       │                               │                                  │
       │── {"sdp":{offer}} ───────────►│──────────────────────────────────►│
       │                               │                                  │
       │◄──────────────────────────────│◄── {"sdp":{answer}} ─────────────│
       │                               │                                  │
       │◄═══════ ICE candidates ═══════╪══════════════════════════════════►│
       │                               │                                  │
       │═══════════════ Media (P2P or TURN relay) ════════════════════════►│
```

### WebSocket Messages

**Join Room:**
```json
{"join": "wall-5538-abc123"}
```

**Offer Request (from viewer):**
```json
{"request": "offer", "UUID": "viewer-uuid"}
```

**SDP Offer (to viewer):**
```json
{
  "sdp": {
    "type": "offer",
    "sdp": "v=0\r\no=- ..."
  },
  "UUID": "viewer-uuid"
}
```

**SDP Answer (from viewer):**
```json
{
  "sdp": {
    "type": "answer",
    "sdp": "v=0\r\no=- ..."
  },
  "UUID": "publisher-uuid"
}
```

**ICE Candidate:**
```json
{
  "candidate": {
    "candidate": "candidate:...",
    "sdpMid": "0",
    "sdpMLineIndex": 0
  },
  "UUID": "target-uuid"
}
```

### VDO.ninja WebSocket Endpoints

| Endpoint | Purpose |
|----------|---------|
| `wss://wss.vdo.ninja:443` | Primary signaling server |
| `wss://api.vdo.ninja:443` | API/control server (also supports signaling) |

---

## webrtc-streamer HTTP API

Based on webrtc-streamer's source code:

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/getMediaList` | GET | List available streams |
| `/api/call` | POST | Create peer connection, get SDP offer |
| `/api/hangup` | POST | Close peer connection |
| `/api/addIceCandidate` | POST | Add remote ICE candidate |
| `/api/getIceCandidate` | GET | Get local ICE candidates |

### `/api/call` - Create Connection

**Request:**
```
POST /api/call?peerid=viewer-123&url=screen://&options=rtptransport=tcp
```

**Response:** SDP Offer
```json
{
  "type": "offer",
  "sdp": "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n..."
}
```

### `/api/hangup` - Close Connection

**Request:**
```
POST /api/hangup?peerid=viewer-123
```

### `/api/addIceCandidate` - Add Remote ICE

**Request:**
```
POST /api/addIceCandidate?peerid=viewer-123
Content-Type: application/json

{
  "candidate": "candidate:842163049 1 udp ...",
  "sdpMid": "0",
  "sdpMLineIndex": 0
}
```

### `/api/getIceCandidate` - Poll Local ICE

**Request:**
```
GET /api/getIceCandidate?peerid=viewer-123
```

**Response:**
```json
[
  {"candidate": "candidate:...", "sdpMid": "0", "sdpMLineIndex": 0},
  {"candidate": "candidate:...", "sdpMid": "0", "sdpMLineIndex": 0}
]
```

---

## Implementation Plan

### Files to Create

| File | Purpose |
|------|---------|
| `src/vdo-bridge.ts` | VDO.ninja signaling bridge module |

### Files to Modify

| File | Changes |
|------|---------|
| `src/server.ts` | Add `/api/remote-stream-*` endpoints |
| `src/streaming.ts` | Add remote state tracking |
| `index.html` | Add remote streaming UI |

---

## Phase 1: Bridge Module (`src/vdo-bridge.ts`)

### State Interface

```typescript
interface VdoBridgeState {
  status: "disconnected" | "connecting" | "connected" | "error";
  roomId: string | null;
  viewerUrl: string | null;
  connectedViewers: Map<string, ViewerConnection>;
  error: string | null;
}

interface ViewerConnection {
  uuid: string;
  peerId: string;        // ID used with webrtc-streamer
  connectedAt: number;
  icePollingInterval: Timer | null;
}
```

### Core Functions

```typescript
// Start bridge - connects to VDO.ninja and waits for viewers
export async function startRemoteBridge(wallId: string): Promise<string>

// Stop bridge - disconnects all viewers and closes WebSocket
export async function stopRemoteBridge(): Promise<void>

// Get current state
export function getBridgeState(): VdoBridgeState
```

### WebSocket Connection

```typescript
const VDO_NINJA_WSS = "wss://wss.vdo.ninja:443";

class VdoNinjaBridge {
  private ws: WebSocket | null = null;
  private roomId: string;
  private viewers: Map<string, ViewerConnection> = new Map();

  async connect(wallId: string): Promise<void> {
    // Generate room ID
    this.roomId = `vu-${wallId}-${Date.now().toString(36)}`;

    // Connect to VDO.ninja
    this.ws = new WebSocket(VDO_NINJA_WSS);

    this.ws.onopen = () => {
      // Join room as publisher
      this.ws.send(JSON.stringify({ join: this.roomId }));
      console.log(`[vdo-bridge] Joined room: ${this.roomId}`);
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(JSON.parse(event.data));
    };

    this.ws.onclose = () => {
      this.handleDisconnect();
    };
  }

  private async handleMessage(msg: any): Promise<void> {
    // Viewer wants to connect - requesting an offer
    if (msg.request === "offer" && msg.UUID) {
      await this.handleOfferRequest(msg.UUID);
    }

    // Viewer sent SDP answer
    if (msg.sdp?.type === "answer" && msg.UUID) {
      await this.handleAnswer(msg.UUID, msg.sdp);
    }

    // Viewer sent ICE candidate
    if (msg.candidate && msg.UUID) {
      await this.handleRemoteIce(msg.UUID, msg.candidate);
    }
  }
}
```

### Offer Flow (Viewer Connects)

```typescript
private async handleOfferRequest(viewerUuid: string): Promise<void> {
  const peerId = `viewer-${viewerUuid.slice(0, 8)}`;

  // 1. Get SDP offer from webrtc-streamer
  const offerRes = await fetch(
    `http://localhost:8000/api/call?peerid=${peerId}&url=screen://`
  );
  const offer = await offerRes.json();

  // 2. Send offer to viewer via VDO.ninja
  this.ws.send(JSON.stringify({
    sdp: offer,
    UUID: viewerUuid
  }));

  // 3. Track viewer and start ICE polling
  const viewer: ViewerConnection = {
    uuid: viewerUuid,
    peerId,
    connectedAt: Date.now(),
    icePollingInterval: null
  };

  // Poll for local ICE candidates
  viewer.icePollingInterval = setInterval(async () => {
    await this.pollAndSendIce(viewer);
  }, 100);

  this.viewers.set(viewerUuid, viewer);
}
```

### Answer Flow

```typescript
private async handleAnswer(viewerUuid: string, sdp: RTCSessionDescription): Promise<void> {
  const viewer = this.viewers.get(viewerUuid);
  if (!viewer) return;

  // webrtc-streamer accepts answer in the same call endpoint
  // The offer/answer is handled internally - we just need ICE
  console.log(`[vdo-bridge] Received answer from viewer ${viewerUuid}`);

  // Note: webrtc-streamer's HTTP API may not need explicit answer setting
  // as some implementations handle it via call parameters
  // Testing will confirm exact behavior
}
```

### ICE Candidate Exchange

```typescript
// Poll webrtc-streamer for local ICE and send to viewer
private async pollAndSendIce(viewer: ViewerConnection): Promise<void> {
  const res = await fetch(
    `http://localhost:8000/api/getIceCandidate?peerid=${viewer.peerId}`
  );
  const candidates = await res.json();

  for (const candidate of candidates) {
    this.ws.send(JSON.stringify({
      candidate,
      UUID: viewer.uuid
    }));
  }
}

// Receive ICE from viewer and add to webrtc-streamer
private async handleRemoteIce(viewerUuid: string, candidate: RTCIceCandidate): Promise<void> {
  const viewer = this.viewers.get(viewerUuid);
  if (!viewer) return;

  await fetch(
    `http://localhost:8000/api/addIceCandidate?peerid=${viewer.peerId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(candidate)
    }
  );
}
```

### Cleanup

```typescript
async disconnect(): Promise<void> {
  // Hangup all viewers
  for (const [uuid, viewer] of this.viewers) {
    if (viewer.icePollingInterval) {
      clearInterval(viewer.icePollingInterval);
    }
    await fetch(`http://localhost:8000/api/hangup?peerid=${viewer.peerId}`, {
      method: "POST"
    });
  }
  this.viewers.clear();

  // Close WebSocket
  if (this.ws) {
    this.ws.close();
    this.ws = null;
  }
}
```

---

## Phase 2: Server Endpoints (`src/server.ts`)

### New Endpoints

```typescript
// Start remote streaming bridge
if (url.pathname === "/api/remote-stream-start" && req.method === "POST") {
  // Ensure local streaming is running first
  const streamState = getStreamingState();
  if (streamState.status !== "running") {
    return jsonResponse({ ok: false, error: "Local streaming not running" }, 400);
  }

  const viewerUrl = await startRemoteBridge(wallId);
  return jsonResponse({
    ok: true,
    viewerUrl,
    roomId: getBridgeState().roomId
  });
}

// Stop remote streaming bridge
if (url.pathname === "/api/remote-stream-stop" && req.method === "POST") {
  await stopRemoteBridge();
  return jsonResponse({ ok: true });
}

// Get remote stream status
if (url.pathname === "/api/remote-stream-status" && req.method === "GET") {
  return jsonResponse(getBridgeState());
}
```

---

## Phase 3: Dashboard UI (`index.html`)

### Remote Streaming Card Addition

```html
<div class="card">
  <h2>Remote Streaming</h2>
  <div id="remoteStreamContent">
    <p>Enable remote viewing without port forwarding via VDO.ninja</p>

    <div class="status-row">
      <span>Status:</span>
      <span id="remoteStatus">Disconnected</span>
    </div>

    <div class="status-row" id="remoteViewerRow" style="display:none">
      <span>Viewer URL:</span>
      <input type="text" id="remoteViewerUrl" readonly onclick="this.select()">
      <button onclick="copyViewerUrl()">Copy</button>
    </div>

    <div class="status-row" id="remoteViewersRow" style="display:none">
      <span>Connected Viewers:</span>
      <span id="remoteViewerCount">0</span>
    </div>

    <div class="actions">
      <button id="btnStartRemote" onclick="startRemoteStream()">Enable Remote Viewing</button>
      <button id="btnStopRemote" onclick="stopRemoteStream()" disabled>Disable</button>
    </div>
  </div>
</div>
```

### JavaScript Functions

```javascript
async function startRemoteStream() {
  // First ensure local streaming is running
  const status = await fetch('/api/stream-status').then(r => r.json());
  if (status.status !== 'running') {
    alert('Please start local streaming first');
    return;
  }

  const res = await fetch('/api/remote-stream-start', { method: 'POST' });
  const data = await res.json();

  if (data.ok) {
    updateRemoteUI(data);
  } else {
    alert('Failed to start remote: ' + data.error);
  }
}

async function stopRemoteStream() {
  await fetch('/api/remote-stream-stop', { method: 'POST' });
  updateRemoteUI({ status: 'disconnected' });
}

function updateRemoteUI(state) {
  document.getElementById('remoteStatus').textContent = state.status || 'Disconnected';

  const urlRow = document.getElementById('remoteViewerRow');
  const viewersRow = document.getElementById('remoteViewersRow');

  if (state.viewerUrl) {
    document.getElementById('remoteViewerUrl').value = state.viewerUrl;
    urlRow.style.display = 'flex';
    viewersRow.style.display = 'flex';
  } else {
    urlRow.style.display = 'none';
    viewersRow.style.display = 'none';
  }

  document.getElementById('btnStartRemote').disabled = state.status === 'connected';
  document.getElementById('btnStopRemote').disabled = state.status !== 'connected';
}

function copyViewerUrl() {
  const input = document.getElementById('remoteViewerUrl');
  input.select();
  navigator.clipboard.writeText(input.value);
}
```

---

## Viewer URL Format

When remote streaming is enabled, users get a URL like:

```
https://vdo.ninja/?view=vu-5538-k7x2m9p
```

This URL:
- Opens VDO.ninja's standard viewer page
- Automatically connects to our stream via their signaling
- Works on any device, anywhere in the world
- Uses VDO.ninja's TURN servers if P2P fails

---

## Message Flow Diagram

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Watchdog    │    │ webrtc-      │    │  VDO.ninja   │    │   Remote     │
│  Bridge      │    │ streamer     │    │  WSS Server  │    │   Viewer     │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │                   │                   │                   │
       │──WSS connect────────────────────────►│                   │
       │──{"join":"vu-5538-xxx"}─────────────►│                   │
       │                   │                   │                   │
       │                   │                   │◄─User opens URL───│
       │                   │                   │                   │
       │◄──{"request":"offer","UUID":"v1"}────│                   │
       │                   │                   │                   │
       │──GET /api/call───►│                   │                   │
       │◄──SDP Offer───────│                   │                   │
       │                   │                   │                   │
       │──{"sdp":offer,"UUID":"v1"}──────────►│──────────────────►│
       │                   │                   │                   │
       │                   │                   │◄──{"sdp":answer}──│
       │◄──{"sdp":answer,"UUID":"v1"}─────────│                   │
       │                   │                   │                   │
       │──GET /api/getIceCandidate──────────►│                   │
       │◄──[ice candidates]│                   │                   │
       │──{"candidate":...,"UUID":"v1"}──────►│──────────────────►│
       │                   │                   │                   │
       │                   │                   │◄──{"candidate":..}│
       │◄──{"candidate":...}──────────────────│                   │
       │──POST /api/addIceCandidate─────────►│                   │
       │                   │                   │                   │
       │                   │═══════════════════════════════════════│
       │                   │        Media Stream (P2P/TURN)        │
       │                   │═══════════════════════════════════════│
```

---

## ICE Configuration

VDO.ninja provides these ICE servers automatically to viewers:

```javascript
iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  {
    urls: "turn:turn.vdo.ninja:443",
    username: "vdoninja",
    credential: "vdoninjapass"
  }
]
```

webrtc-streamer uses its own embedded STUN/TURN, but the viewer's ICE candidates will work with both.

---

## Error Handling

### Connection Failures

```typescript
this.ws.onerror = (error) => {
  console.error("[vdo-bridge] WebSocket error:", error);
  this.state.status = "error";
  this.state.error = "VDO.ninja connection failed";
};

this.ws.onclose = (event) => {
  if (event.code !== 1000) {
    // Abnormal close - attempt reconnect
    setTimeout(() => this.connect(this.wallId), 5000);
  }
};
```

### webrtc-streamer Not Running

```typescript
async function startRemoteBridge(wallId: string): Promise<string> {
  // Check webrtc-streamer is running
  try {
    const res = await fetch("http://localhost:8000/api/getMediaList");
    if (!res.ok) throw new Error("webrtc-streamer not responding");
  } catch {
    throw new Error("Local streaming must be running first");
  }

  // ... continue with bridge setup
}
```

### Viewer Disconnect

```typescript
// Detect via periodic health check or ICE failure
private checkViewerHealth(viewer: ViewerConnection): void {
  // If no ICE activity for 30s, consider disconnected
  // Clean up peer connection
}
```

---

## Implementation Order

| Step | Task | Depends On |
|------|------|------------|
| 1 | Create `src/vdo-bridge.ts` with WebSocket client | - |
| 2 | Implement offer/answer flow | Step 1 |
| 3 | Implement ICE candidate exchange | Step 2 |
| 4 | Add server endpoints | Step 3 |
| 5 | Add dashboard UI | Step 4 |
| 6 | Test with remote viewer | All above |

---

## Testing Plan

### Local Testing

1. Start watchdog: `bun run dev`
2. Start local streaming via dashboard
3. Enable remote streaming
4. Open viewer URL in different browser/device on same network
5. Verify video appears

### Remote Testing

1. Start local + remote streaming
2. Share viewer URL with someone outside your network
3. Verify they can connect and see the stream
4. Check if connection is P2P or TURN relay

### Debugging

- VDO.ninja messages: Add console logging for all WS messages
- ICE candidates: Log each candidate type (host/srflx/relay)
- webrtc-streamer: Check http://localhost:8000/api/getMediaList

---

## Limitations

1. **Single stream**: One room ID per watchdog instance
2. **VDO.ninja dependency**: Relies on their public servers
3. **No auth**: Anyone with the URL can view (could add password via VDO.ninja params)
4. **Viewer limit**: webrtc-streamer default limit applies

---

## Future Enhancements

1. **Password protection**: Add `&password=xxx` to VDO.ninja URL
2. **Quality control**: Expose bitrate/resolution settings
3. **Viewer management**: Kick individual viewers
4. **QR code**: Generate QR for mobile access
5. **Self-hosted signaling**: Use own WebSocket server for enterprise deployments

---

## Dependencies

No new npm dependencies required. Uses:
- Native WebSocket (Bun built-in)
- Existing webrtc-streamer binary
- VDO.ninja public infrastructure (free)

---

## Security Notes

1. Room IDs are random and unguessable
2. VDO.ninja uses WSS (encrypted signaling)
3. WebRTC media is always encrypted (DTLS-SRTP)
4. No credentials stored - uses VDO.ninja's free tier
