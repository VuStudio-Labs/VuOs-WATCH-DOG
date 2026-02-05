# WebRTC Screen Sharing — Technical Deep Dive

This document explains how WebRTC works for real-time screen sharing, from capture to display.

---

## Table of Contents

1. [Overview](#overview)
2. [The WebRTC Stack](#the-webrtc-stack)
3. [Screen Capture](#screen-capture)
4. [Video Encoding](#video-encoding)
5. [Signaling](#signaling)
6. [ICE — Finding a Path](#ice--finding-a-path)
7. [STUN — NAT Discovery](#stun--nat-discovery)
8. [TURN — Relay Fallback](#turn--relay-fallback)
9. [DTLS & SRTP — Security](#dtls--srtp--security)
10. [RTP — Media Transport](#rtp--media-transport)
11. [Connection Lifecycle](#connection-lifecycle)
12. [Latency Breakdown](#latency-breakdown)
13. [Comparison with Other Protocols](#comparison-with-other-protocols)

---

## Overview

**WebRTC** (Web Real-Time Communication) is a set of protocols and APIs that enable peer-to-peer audio, video, and data transmission directly between browsers or applications — without requiring an intermediary server for the media itself.

For screen sharing, the flow is:

```
┌─────────────────┐                              ┌─────────────────┐
│  Screen Source  │                              │     Viewer      │
│   (Wall PC)     │                              │   (Browser)     │
├─────────────────┤                              ├─────────────────┤
│ 1. Capture      │                              │                 │
│    (DXGI/GDI)   │                              │                 │
│       ↓         │                              │                 │
│ 2. Encode       │                              │                 │
│    (H.264)      │                              │                 │
│       ↓         │     Signaling (HTTP/WS)      │                 │
│ 3. Packetize    │◄────────────────────────────►│ 7. SDP Exchange │
│    (RTP)        │                              │                 │
│       ↓         │      ICE Candidates          │                 │
│ 4. Encrypt      │◄────────────────────────────►│ 8. ICE Exchange │
│    (SRTP)       │                              │                 │
│       ↓         │                              │       ↓         │
│ 5. Send         │─────── UDP (P2P/TURN) ──────►│ 9. Receive      │
│                 │                              │       ↓         │
│                 │                              │ 10. Decrypt     │
│                 │                              │       ↓         │
│                 │                              │ 11. Decode      │
│                 │                              │       ↓         │
│                 │                              │ 12. Render      │
└─────────────────┘                              └─────────────────┘
```

---

## The WebRTC Stack

WebRTC is built on several layered protocols:

```
┌─────────────────────────────────────────┐
│            Application Layer            │
│   (Screen capture, video rendering)     │
├─────────────────────────────────────────┤
│              Codec Layer                │
│      H.264 / VP8 / VP9 / AV1            │
├─────────────────────────────────────────┤
│           RTP / RTCP Layer              │
│   (Media packetization & feedback)      │
├─────────────────────────────────────────┤
│          SRTP / SRTCP Layer             │
│       (Encryption of media)             │
├─────────────────────────────────────────┤
│            DTLS Layer                   │
│   (Key exchange for SRTP)               │
├─────────────────────────────────────────┤
│            ICE Layer                    │
│   (NAT traversal, path selection)       │
├─────────────────────────────────────────┤
│         UDP / TCP Transport             │
│   (Actual packet delivery)              │
└─────────────────────────────────────────┘
```

| Layer | Protocol | Purpose |
|-------|----------|---------|
| Signaling | HTTP/WebSocket | Exchange SDP offers/answers and ICE candidates |
| NAT Traversal | ICE, STUN, TURN | Find a network path between peers |
| Security | DTLS, SRTP | Encrypt key exchange and media |
| Media | RTP, RTCP | Packetize and transport video/audio |
| Codec | H.264, VP8/9, AV1, Opus | Compress video/audio |

---

## Screen Capture

### Windows Desktop Duplication API (DXGI)

Modern screen capture on Windows uses the **Desktop Duplication API** introduced in Windows 8. It captures directly from the GPU's front buffer.

```cpp
// Simplified DXGI capture flow
IDXGIOutputDuplication* duplication;
output->DuplicateOutput(device, &duplication);

while (streaming) {
    DXGI_OUTDUPL_FRAME_INFO frameInfo;
    IDXGIResource* resource;

    // Acquire the next frame from GPU
    duplication->AcquireNextFrame(timeout, &frameInfo, &resource);

    // Get the texture
    ID3D11Texture2D* texture;
    resource->QueryInterface(&texture);

    // Copy to CPU or encode directly on GPU
    context->CopyResource(stagingTexture, texture);

    // Release frame back to system
    duplication->ReleaseFrame();
}
```

**Advantages:**
- Captures at GPU speed (no CPU copy for capture)
- Includes hardware overlays, fullscreen games, DRM-free content
- Provides dirty rectangles (only changed regions)
- Supports HDR content

**Limitations:**
- Only captures one monitor at a time
- Requires Windows 8+
- Some DRM content is blacked out

### GDI Capture (Legacy)

Older method using `BitBlt`:

```cpp
HDC screenDC = GetDC(NULL);
HDC memDC = CreateCompatibleDC(screenDC);
HBITMAP bitmap = CreateCompatibleBitmap(screenDC, width, height);
SelectObject(memDC, bitmap);
BitBlt(memDC, 0, 0, width, height, screenDC, 0, 0, SRCCOPY);
```

**Disadvantages:**
- CPU-intensive
- Cannot capture hardware overlays
- Cannot capture fullscreen exclusive apps
- No dirty rectangle optimization

---

## Video Encoding

### H.264 (AVC)

The most widely supported codec for WebRTC screen sharing.

```
Raw Frame (1920x1080 RGB)     Encoded Frame
      ~6 MB                      ~50 KB
         │                          │
         ▼                          │
   ┌───────────┐                    │
   │  Encoder  │────────────────────┘
   │  (H.264)  │
   └───────────┘
        │
        ▼
   Compression: ~99%
```

**H.264 Encoding Parameters for Screen Sharing:**

| Parameter | Typical Value | Purpose |
|-----------|---------------|---------|
| Profile | Baseline/Main | Compatibility vs features |
| Level | 4.0-5.1 | Resolution/framerate limits |
| Bitrate | 2-6 Mbps | Quality vs bandwidth |
| Keyframe Interval | 2-3 sec | Seek points, error recovery |
| Rate Control | CBR or VBR | Constant vs variable bitrate |
| Preset | ultrafast/veryfast | Speed vs compression efficiency |
| Tune | zerolatency | Minimize encoding delay |

**Frame Types:**

```
Timeline: ──────────────────────────────────────►

I-frame    P-frame   P-frame   P-frame   I-frame
(Keyframe) (Delta)   (Delta)   (Delta)   (Keyframe)
   │          │         │         │          │
   ▼          ▼         ▼         ▼          ▼
┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐
│Full  │  │Changes│  │Changes│  │Changes│  │Full  │
│Frame │  │Only   │  │Only   │  │Only   │  │Frame │
│150KB │  │10KB   │  │8KB    │  │12KB   │  │150KB │
└──────┘  └──────┘  └──────┘  └──────┘  └──────┘
```

- **I-frame (Intra)**: Complete frame, no dependencies. Large but enables random access.
- **P-frame (Predicted)**: Only differences from previous frame. Small but requires prior frames.
- **B-frame (Bidirectional)**: References past and future frames. Smallest but adds latency. Usually disabled for real-time.

### Hardware Encoding

Modern GPUs have dedicated encoding hardware:

| Platform | Encoder | API |
|----------|---------|-----|
| NVIDIA | NVENC | CUDA/NVENC |
| AMD | VCE/VCN | AMF |
| Intel | Quick Sync | Media SDK |

Hardware encoding offloads CPU, enabling high resolution/framerate with low latency.

---

## Signaling

WebRTC requires an out-of-band **signaling** mechanism to exchange connection metadata. This is NOT part of the WebRTC spec — you implement it yourself (HTTP, WebSocket, etc.).

### What's Exchanged

**1. SDP (Session Description Protocol)**

A text format describing media capabilities:

```
v=0
o=- 1234567890 2 IN IP4 127.0.0.1
s=-
t=0 0
m=video 9 UDP/TLS/RTP/SAVPF 96 97
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:abcd
a=ice-pwd:secretpassword123
a=fingerprint:sha-256 AA:BB:CC:DD:...
a=setup:actpass
a=mid:0
a=sendonly
a=rtcp-mux
a=rtpmap:96 H264/90000
a=fmtp:96 profile-level-id=42e01f;packetization-mode=1
a=rtpmap:97 VP8/90000
```

Key fields:
- `ice-ufrag` / `ice-pwd`: ICE credentials
- `fingerprint`: DTLS certificate fingerprint for security
- `rtpmap`: Codec mappings (96 = H.264, 97 = VP8)
- `fmtp`: Codec parameters

**2. ICE Candidates**

Network path options:

```
candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host
candidate:2 1 UDP 1686052607 203.0.113.50 54321 typ srflx raddr 192.168.1.100 rport 54321
candidate:3 1 UDP 41885439 turn.example.com 3478 typ relay raddr 203.0.113.50 rport 54321
```

Types:
- `host`: Local IP (private)
- `srflx`: Server-reflexive (public IP via STUN)
- `relay`: TURN relay address

### Offer/Answer Model

```
   Sender (Wall PC)                    Receiver (Browser)
         │                                    │
         │──────── SDP Offer ────────────────►│
         │                                    │
         │                                    │ (Process offer,
         │                                    │  create answer)
         │                                    │
         │◄─────── SDP Answer ────────────────│
         │                                    │
         │◄──────► ICE Candidates ◄──────────►│
         │         (trickle ICE)              │
         │                                    │
         │═══════ Media Flow (RTP) ══════════►│
```

---

## ICE — Finding a Path

**ICE (Interactive Connectivity Establishment)** systematically tries different network paths to find one that works.

### Candidate Gathering

```
┌─────────────────────────────────────────────────────────┐
│                    Local Machine                        │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   Host      │  │   STUN      │  │   TURN      │     │
│  │  Candidate  │  │  Candidate  │  │  Candidate  │     │
│  │             │  │             │  │             │     │
│  │ 192.168.1.5 │  │203.0.113.50 │  │ turn:3478   │     │
│  │  :54321     │  │  :54321     │  │  (relay)    │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
│        │                │                │              │
└────────┼────────────────┼────────────────┼──────────────┘
         │                │                │
         └────────────────┼────────────────┘
                          │
                          ▼
                   Candidate List
                   (sent to peer)
```

### Connectivity Checks

ICE performs connectivity checks on all candidate pairs:

```
Sender Candidates          Receiver Candidates
┌───────────────┐          ┌───────────────┐
│ host:54321    │──────────│ host:12345    │  ✗ (different LANs)
│ srflx:54321   │──────────│ host:12345    │  ✗
│ host:54321    │──────────│ srflx:12345   │  ✗
│ srflx:54321   │──────────│ srflx:12345   │  ✓ (P2P works!)
│ relay:3478    │──────────│ srflx:12345   │  ✓ (backup)
└───────────────┘          └───────────────┘
```

The check uses **STUN Binding Requests** over the candidate pairs. If a response comes back, the path works.

### Candidate Pair States

```
        ┌─────────┐
        │ Frozen  │ (waiting for higher-priority pairs)
        └────┬────┘
             │ unfreeze
             ▼
        ┌─────────┐
        │ Waiting │ (ready to check)
        └────┬────┘
             │ send check
             ▼
      ┌──────────────┐
      │ In-Progress  │ (check sent, awaiting response)
      └──────┬───────┘
             │
     ┌───────┴───────┐
     │               │
     ▼               ▼
┌─────────┐    ┌─────────┐
│Succeeded│    │ Failed  │
└─────────┘    └─────────┘
```

---

## STUN — NAT Discovery

**STUN (Session Traversal Utilities for NAT)** helps peers discover their public IP address and port mapping.

### How STUN Works

```
┌──────────────────┐                    ┌──────────────────┐
│    Your PC       │                    │   STUN Server    │
│ (192.168.1.100)  │                    │ (stun.google.com)│
└────────┬─────────┘                    └────────┬─────────┘
         │                                       │
         │  STUN Binding Request                 │
         │  src: 192.168.1.100:54321             │
         │────────────────────────────────────►  │
         │                                       │
         │        NAT translates to:             │
         │        src: 203.0.113.50:12345        │
         │                                       │
         │  STUN Binding Response                │
         │  "Your public address is:             │
         │   203.0.113.50:12345"                 │
         │ ◄────────────────────────────────────│
         │                                       │
```

Now the peer knows its public IP and port, which it shares as a `srflx` (server-reflexive) candidate.

### NAT Types and STUN Success

| NAT Type | Description | P2P Possible? |
|----------|-------------|---------------|
| **Full Cone** | Any external host can send to mapped port | Yes |
| **Restricted Cone** | Only hosts you've sent to can reply | Yes |
| **Port Restricted** | Only specific IP:port you've sent to can reply | Usually yes |
| **Symmetric** | Different mapping for each destination | Often no (need TURN) |

```
Full Cone NAT:
External ──► NAT:12345 ──► Internal:54321
(anyone)

Symmetric NAT:
To Server A: NAT:12345 ──► Internal:54321
To Server B: NAT:12346 ──► Internal:54321  (different port!)
```

Symmetric NAT breaks STUN because the port discovered via the STUN server won't work for other peers.

---

## TURN — Relay Fallback

**TURN (Traversal Using Relays around NAT)** is a last resort when P2P fails. It relays all media through a server.

### TURN Architecture

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Sender    │         │ TURN Server │         │  Receiver   │
│ (Wall PC)   │         │  (Relay)    │         │ (Browser)   │
└──────┬──────┘         └──────┬──────┘         └──────┬──────┘
       │                       │                       │
       │ ═══ Media ═══════════►│                       │
       │                       │═══ Media ════════════►│
       │                       │                       │
       │◄══════════════════════│◄══════════════════════│
       │                       │                       │
```

### TURN Allocation

```
1. Client ──► TURN Server: Allocate Request
2. TURN Server allocates a relay address (e.g., 198.51.100.10:49152)
3. TURN Server ──► Client: Allocate Response (relay address)
4. Client shares relay address as ICE candidate
5. Media flows: Client ◄──► TURN ◄──► Peer
```

### TURN vs STUN

| Aspect | STUN | TURN |
|--------|------|------|
| Purpose | Discover public IP | Relay media |
| Bandwidth | Minimal (few packets) | All media passes through |
| Cost | Free (Google, etc.) | Expensive (bandwidth costs) |
| Latency | None added | +20-100ms RTT |
| Reliability | ~80% success | 100% success |

---

## DTLS & SRTP — Security

WebRTC mandates encryption. No unencrypted media is allowed.

### DTLS Handshake

**DTLS (Datagram TLS)** is TLS adapted for UDP. It establishes encryption keys.

```
┌────────────┐                              ┌────────────┐
│   Sender   │                              │  Receiver  │
└─────┬──────┘                              └─────┬──────┘
      │                                           │
      │────── ClientHello ───────────────────────►│
      │                                           │
      │◄───── ServerHello + Certificate ──────────│
      │                                           │
      │────── Certificate + KeyExchange ─────────►│
      │                                           │
      │◄───── Finished ───────────────────────────│
      │                                           │
      │────── Finished ──────────────────────────►│
      │                                           │
      │         (SRTP keys derived)               │
      │                                           │
      │═══════ Encrypted Media (SRTP) ═══════════►│
```

### SRTP Encryption

**SRTP (Secure RTP)** encrypts RTP media packets using keys from DTLS.

```
┌─────────────────────────────────────────────────────────┐
│                    SRTP Packet                          │
├──────────────┬─────────────────────────┬───────────────┤
│  RTP Header  │   Encrypted Payload     │  Auth Tag     │
│  (12 bytes)  │   (variable)            │  (10 bytes)   │
│  cleartext   │   AES-CTR encrypted     │  HMAC-SHA1    │
└──────────────┴─────────────────────────┴───────────────┘
```

- Payload is encrypted (AES-128-CTR typically)
- Header is not encrypted (needed for routing)
- Auth tag prevents tampering

---

## RTP — Media Transport

**RTP (Real-time Transport Protocol)** carries the actual video/audio data.

### RTP Packet Structure

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|V=2|P|X|  CC   |M|     PT      |       Sequence Number         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                           Timestamp                           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                             SSRC                              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                            Payload                            |
|                             ...                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Field | Size | Purpose |
|-------|------|---------|
| V | 2 bits | Version (always 2) |
| P | 1 bit | Padding flag |
| X | 1 bit | Extension header present |
| CC | 4 bits | CSRC count |
| M | 1 bit | Marker (e.g., end of frame) |
| PT | 7 bits | Payload type (codec identifier) |
| Sequence | 16 bits | Packet ordering, loss detection |
| Timestamp | 32 bits | Media timing (90kHz for video) |
| SSRC | 32 bits | Stream identifier |

### Packetization

Video frames are split into MTU-sized packets (~1200 bytes):

```
H.264 Frame (50KB)
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│ NAL Unit 1 │ NAL Unit 2 │ NAL Unit 3 │ ... │ NAL Unit N │
└──────────────────────────────────────────────────────────┘
       │
       ▼ (Fragment into RTP packets)
┌─────────┐ ┌─────────┐ ┌─────────┐       ┌─────────┐
│ RTP #1  │ │ RTP #2  │ │ RTP #3  │  ...  │ RTP #42 │
│ 1200B   │ │ 1200B   │ │ 1200B   │       │ 800B    │
└─────────┘ └─────────┘ └─────────┘       └─────────┘
```

### RTCP — Feedback

**RTCP (RTP Control Protocol)** provides feedback for quality adaptation:

- **Sender Reports (SR)**: Packets sent, bytes sent, timestamps
- **Receiver Reports (RR)**: Packets lost, jitter, RTT
- **NACK**: Request retransmission of lost packets
- **PLI**: Picture Loss Indication (request new keyframe)
- **REMB**: Receiver Estimated Max Bitrate

```
Sender                                  Receiver
   │                                        │
   │══════ RTP Video ══════════════════════►│
   │                                        │
   │◄─────── RTCP RR (5% loss) ─────────────│
   │                                        │
   │ (reduce bitrate)                       │
   │                                        │
   │══════ RTP Video (lower bitrate) ══════►│
   │                                        │
   │◄─────── RTCP PLI (keyframe needed) ────│
   │                                        │
   │══════ RTP I-frame ════════════════════►│
```

---

## Connection Lifecycle

### Complete WebRTC Connection

```
Time ──────────────────────────────────────────────────────────►

     Sender                 Signaling               Receiver
        │                    Server                     │
        │                       │                       │
   1.   │ Create PeerConnection │                       │
        │ Gather ICE candidates │                       │
        │                       │                       │
   2.   │──── SDP Offer ───────►│                       │
        │                       │──── SDP Offer ───────►│
        │                       │                       │
   3.   │                       │                       │ Create PeerConnection
        │                       │                       │ Set remote description
        │                       │                       │ Create answer
        │                       │                       │
   4.   │                       │◄──── SDP Answer ──────│
        │◄──── SDP Answer ──────│                       │
        │                       │                       │
   5.   │◄────────────────► ICE Candidates ◄───────────►│
        │                  (trickle ICE)                │
        │                       │                       │
   6.   │◄═══════════ ICE Connectivity Checks ═════════►│
        │                                               │
   7.   │◄════════════ DTLS Handshake ═════════════════►│
        │                                               │
   8.   │═══════════════ SRTP Media ═══════════════════►│
        │                                               │
   9.   │◄══════════════ RTCP Feedback ════════════════►│
        │                                               │
```

### State Machine

```
┌───────────────┐
│     new       │ (PeerConnection created)
└───────┬───────┘
        │ setLocalDescription / setRemoteDescription
        ▼
┌───────────────┐
│  connecting   │ (ICE checking, DTLS handshaking)
└───────┬───────┘
        │ ICE connected + DTLS complete
        ▼
┌───────────────┐
│  connected    │ (media flowing)
└───────┬───────┘
        │ ICE disconnected / network change
        ▼
┌───────────────┐
│ disconnected  │ (temporary, may recover)
└───────┬───────┘
        │ ICE failed / close()
        ▼
┌───────────────┐
│    closed     │ (terminal)
└───────────────┘
```

---

## Latency Breakdown

End-to-end latency for screen sharing:

```
Component                          Typical Latency
─────────────────────────────────────────────────
Screen Capture (DXGI)              ~8-16ms (1-2 frames @ 60fps)
Encoding (H.264 hardware)          ~5-15ms
Packetization (RTP)                ~1ms
Network (local LAN)                ~1-5ms
Network (internet, P2P)            ~20-100ms
Network (TURN relay)               ~40-150ms
Jitter buffer                      ~20-50ms
Decoding (hardware)                ~5-10ms
Rendering                          ~8-16ms (vsync)
─────────────────────────────────────────────────
Total (LAN, P2P)                   ~70-120ms
Total (Internet, P2P)              ~100-250ms
Total (Internet, TURN)             ~150-400ms
```

### Reducing Latency

| Technique | Impact |
|-----------|--------|
| Hardware encoding | -20-50ms vs software |
| Disable B-frames | -30-60ms |
| Reduce jitter buffer | -20-40ms (risk of stutter) |
| Use P2P over TURN | -30-100ms |
| Lower resolution | Indirect (more headroom) |
| Tune `zerolatency` preset | -10-20ms |

---

## Comparison with Other Protocols

| Protocol | Latency | Setup | NAT Traversal | Use Case |
|----------|---------|-------|---------------|----------|
| **WebRTC** | 100-500ms | Complex | Built-in (ICE) | Real-time, interactive |
| **HLS** | 6-30s | Simple | None needed | Broadcast, VOD |
| **DASH** | 3-10s | Medium | None needed | Adaptive streaming |
| **RTMP** | 1-5s | Medium | Requires server | Live streaming ingest |
| **SRT** | 200-500ms | Medium | Manual | Professional broadcast |
| **NDI** | <1 frame | Simple | LAN only | Professional AV |

WebRTC's advantage is **sub-second latency with built-in NAT traversal** — ideal for remote desktop viewing.

---

## References

- [RFC 8825 - WebRTC Overview](https://tools.ietf.org/html/rfc8825)
- [RFC 8445 - ICE](https://tools.ietf.org/html/rfc8445)
- [RFC 5389 - STUN](https://tools.ietf.org/html/rfc5389)
- [RFC 5766 - TURN](https://tools.ietf.org/html/rfc5766)
- [RFC 3550 - RTP](https://tools.ietf.org/html/rfc3550)
- [RFC 3711 - SRTP](https://tools.ietf.org/html/rfc3711)
- [webrtc-streamer source](https://github.com/mpromonet/webrtc-streamer)
