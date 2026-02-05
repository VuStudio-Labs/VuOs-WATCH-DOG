# Remote Viewing Setup

This document explains how to set up a remote viewer to watch the watchdog's screen stream.

## MQTT Streaming Control

Control streaming via MQTT commands to `watchdog/{wallId}/command/{clientId}`:

### Start Stream
```json
{
  "schema": "vu.watchdog.command.v1",
  "ts": 1234567890,
  "commandId": "unique-id",
  "ttlMs": 15000,
  "type": "START_STREAM",
  "args": {
    "monitor": 0
  }
}
```

- `monitor`: 0 = primary, 1 = second monitor, null = all monitors

### Stop Stream
```json
{
  "schema": "vu.watchdog.command.v1",
  "ts": 1234567890,
  "commandId": "unique-id",
  "ttlMs": 15000,
  "type": "STOP_STREAM",
  "args": {}
}
```

### Stream Status

Subscribe to `watchdog/{wallId}/stream/status` for streaming state updates (retained):

```json
{
  "status": "running",
  "pid": 12345,
  "port": 8000,
  "startedAt": 1234567890,
  "viewerUrl": "http://localhost:8000/webrtcstreamer.html?video=desktop",
  "error": null,
  "monitor": 0,
  "available": true
}
```

### Watchdog Status (LWT)

Subscribe to `watchdog/{wallId}/status` for watchdog online/offline status. Includes stream status in the payload. Uses MQTT Last Will and Testament (LWT) to automatically publish when watchdog disconnects unexpectedly:

**Online:**
```json
{
  "status": "online",
  "wallId": "5538",
  "timestamp": 1234567890,
  "stream": { "status": "stopped" }
}
```

**Offline (LWT):**
```json
{
  "status": "offline",
  "wallId": "5538",
  "timestamp": 1234567890,
  "stream": { "status": "stopped" }
}
```

---

## Architecture

```
┌─────────────────┐         ┌──────────────┐         ┌─────────────────┐
│   Watchdog      │         │    MQTT      │         │   Viewer        │
│                 │         │   Broker     │         │   (Browser)     │
│ webrtc-streamer │◄───────►│   (EMQX)     │◄───────►│                 │
│ remote-bridge   │         │              │         │   WebRTC        │
└─────────────────┘         └──────────────┘         └─────────────────┘
```

## MQTT Topics

All topics are scoped to a wall ID: `watchdog/{wallId}/webrtc/...`

| Topic | Direction | Purpose |
|-------|-----------|---------|
| `watchdog/{wallId}/webrtc/offer` | Watchdog → Viewer | SDP offers (retained "ready" message) |
| `watchdog/{wallId}/webrtc/answer` | Viewer → Watchdog | SDP answers |
| `watchdog/{wallId}/webrtc/ice` | Bidirectional | ICE candidates |
| `watchdog/{wallId}/webrtc/join` | Viewer → Watchdog | Viewer announces join |
| `watchdog/{wallId}/webrtc/leave` | Viewer → Watchdog | Viewer announces leave |

## MQTT Broker

Connect to the EMQX broker:

```
URL: wss://c9b6cc55.ala.us-east-1.emqxsl.com:8084/mqtt
Username: dev
Password: testing
```

## Signaling Flow

```
Viewer                          MQTT                         Watchdog
  │                               │                               │
  │──── Connect to MQTT ─────────►│                               │
  │                               │                               │
  │──── Subscribe to:             │                               │
  │     webrtc/{wallId}/offer     │                               │
  │     webrtc/{wallId}/ice       │                               │
  │                               │                               │
  │──── Publish JOIN ────────────►│──── Forward ─────────────────►│
  │     {from: viewerId}          │                               │
  │                               │                               │
  │                               │◄──── Publish OFFER ───────────│
  │◄──── Receive OFFER ───────────│      {description, to, from}  │
  │                               │                               │
  │     [Create RTCPeerConnection]│                               │
  │     [Set remote description]  │                               │
  │     [Create answer]           │                               │
  │                               │                               │
  │──── Publish ANSWER ──────────►│──── Forward ─────────────────►│
  │     {description, to, from}   │                               │
  │                               │                               │
  │◄─── ICE Candidates ──────────►│◄──── ICE Candidates ─────────►│
  │                               │                               │
  │◄══════════════ WebRTC P2P Connection ════════════════════════►│
  │                               │                               │
```

## Message Formats

### Join Request
```json
{
  "from": "viewer-abc123"
}
```

### Offer (from Watchdog)
```json
{
  "type": "offer",
  "description": {
    "type": "offer",
    "sdp": "v=0\r\no=- ..."
  },
  "to": "viewer-abc123",
  "from": "pub-xyz789"
}
```

### Answer (from Viewer)
```json
{
  "description": {
    "type": "answer",
    "sdp": "v=0\r\no=- ..."
  },
  "to": "pub-xyz789",
  "from": "viewer-abc123"
}
```

### ICE Candidate
```json
{
  "candidate": {
    "candidate": "candidate:...",
    "sdpMLineIndex": 0,
    "sdpMid": "0"
  },
  "to": "viewer-abc123",
  "from": "pub-xyz789"
}
```

## Sample Viewer Implementation

```html
<!DOCTYPE html>
<html>
<head>
  <title>Remote Viewer</title>
  <script src="https://unpkg.com/mqtt/dist/mqtt.min.js"></script>
</head>
<body>
  <video id="video" autoplay playsinline></video>
  <script>
    const wallId = new URLSearchParams(location.search).get('wall');
    const myId = 'viewer-' + Math.random().toString(36).slice(2, 10);

    // MQTT connection
    const client = mqtt.connect('wss://c9b6cc55.ala.us-east-1.emqxsl.com:8084/mqtt', {
      username: 'dev',
      password: 'testing'
    });

    let pc = null;
    let publisherId = null;

    const TOPICS = {
      offer: `watchdog/${wallId}/webrtc/offer`,
      answer: `watchdog/${wallId}/webrtc/answer`,
      ice: `watchdog/${wallId}/webrtc/ice`,
      join: `watchdog/${wallId}/webrtc/join`,
      leave: `watchdog/${wallId}/webrtc/leave`
    };

    client.on('connect', () => {
      console.log('Connected to MQTT');

      // Subscribe to offers and ICE
      client.subscribe([TOPICS.offer, TOPICS.ice]);

      // Announce join
      client.publish(TOPICS.join, JSON.stringify({ from: myId }));
    });

    client.on('message', async (topic, payload) => {
      const msg = JSON.parse(payload.toString());

      // Ignore our own messages
      if (msg.from === myId) return;

      // Ignore messages not for us
      if (msg.to && msg.to !== myId) return;

      // Handle offer
      if (topic === TOPICS.offer && msg.description?.type === 'offer') {
        publisherId = msg.from;
        await handleOffer(msg.description);
      }

      // Handle ICE candidate
      if (topic === TOPICS.ice && msg.candidate && pc) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch (e) {
          console.warn('ICE error:', e);
        }
      }
    });

    async function handleOffer(offer) {
      pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      pc.ontrack = (e) => {
        document.getElementById('video').srcObject = e.streams[0];
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          client.publish(TOPICS.ice, JSON.stringify({
            candidate: e.candidate,
            to: publisherId,
            from: myId
          }));
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      client.publish(TOPICS.answer, JSON.stringify({
        description: answer,
        to: publisherId,
        from: myId
      }));
    }

    // Cleanup on close
    window.onbeforeunload = () => {
      client.publish(TOPICS.leave, JSON.stringify({ from: myId }));
    };
  </script>
</body>
</html>
```

## Starting Remote Viewing

### Via API

```bash
# Start local streaming first
curl -X POST http://localhost:3200/api/stream-start

# Then start remote viewing
curl -X POST http://localhost:3200/api/remote-stream-start
```

### Via Dashboard

1. Open http://localhost:3200
2. Click "Start Streaming"
3. Click "Enable Remote Viewing"

## Troubleshooting

### No video received
- Ensure watchdog's local streaming is running first
- Check MQTT connection on both ends
- Verify wall ID matches

### ICE connection failed
- Check firewall settings
- Try adding TURN server to ICE configuration
- Ensure both parties can reach each other (NAT traversal)

### MQTT connection fails
- Verify credentials
- Check network connectivity to EMQX broker
- Ensure WebSocket port 8084 is accessible
