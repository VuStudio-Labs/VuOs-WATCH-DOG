# Plan: VDO.ninja-Style Remote Streaming

## Current State

We use **webrtc-streamer** (external binary) which:
- Captures screen via DXGI
- Handles WebRTC internally
- Requires port 8000 + TURN port exposed for remote access
- Works but is a "black box"

## Goal

Apply VDO.ninja's approach for **easy remote viewing** without port forwarding or tunnels.

---

## How VDO.ninja Works (Remotely)

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│    Publisher    │         │  Handshake/TURN │         │     Viewer      │
│   (Browser)     │         │    Server       │         │   (Browser)     │
│                 │         │  (vdo.ninja)    │         │                 │
└────────┬────────┘         └────────┬────────┘         └────────┬────────┘
         │                           │                           │
         │──── Join room ───────────►│                           │
         │                           │◄──── Join room ───────────│
         │                           │                           │
         │◄──────── SDP Offer ───────┼───────────────────────────│
         │                           │                           │
         │───────── SDP Answer ──────┼──────────────────────────►│
         │                           │                           │
         │◄═══════ ICE Candidates ═══╪══════════════════════════►│
         │                           │                           │
         │                    (P2P if possible)                  │
         │═══════════════════════════════════════════════════════│
         │                           │                           │
         │                    (TURN relay if needed)             │
         │═══════════════════ Media ═╪══════════════════════════►│
```

**Key insight**: VDO.ninja provides:
1. **Signaling server** (WebSocket) - Free, public
2. **TURN servers** - Free relay when P2P fails
3. **Room-based connections** - Simple link sharing

---

## Options

### Option A: Integrate with VDO.ninja Infrastructure

Use VDO.ninja's public servers for signaling and TURN.

**How it would work:**
```
Watchdog (Wall PC)                     VDO.ninja                    Remote Viewer
       │                                  │                              │
       │  Generate room ID                │                              │
       │  (e.g., "wall-5538-abc123")      │                              │
       │                                  │                              │
       │  Capture screen via browser      │                              │
       │  (Electron/Puppeteer headless)   │                              │
       │                                  │                              │
       │──── Connect to wss://vdo.ninja ──►                              │
       │                                  │                              │
       │                                  │  User opens link:            │
       │                                  │  vdo.ninja/?view=wall-5538   │
       │                                  │◄─────────────────────────────│
       │                                  │                              │
       │◄════════ WebRTC via VDO.ninja servers ════════════════════════►│
```

**Pros:**
- No port forwarding needed
- Free TURN relay included
- Proven infrastructure (thousands of users)
- Simple viewer URL to share

**Cons:**
- Dependency on external service
- Need Electron/browser for screen capture (getDisplayMedia is browser-only)
- Less control over quality/latency settings

---

### Option B: Build Our Own with werift (Pure JS WebRTC)

Use [werift](https://github.com/AtsushiOgata/werift-webrtc) - a pure TypeScript WebRTC implementation that works in Node/Bun.

**Architecture:**
```
┌─────────────────────────────────────────────────────────────────┐
│                        Watchdog (Wall PC)                       │
│                                                                 │
│  ┌───────────┐    pipe    ┌───────────┐    WebRTC   ┌────────┐ │
│  │  FFmpeg   │───────────►│  werift   │◄───────────►│Viewer  │ │
│  │ (gdigrab) │   H264     │  (Bun)    │   P2P/TURN  │Browser │ │
│  └───────────┘            └─────┬─────┘             └────────┘ │
│                                 │                               │
│                          ┌──────▼──────┐                        │
│                          │  Signaling  │                        │
│                          │  (our WS)   │                        │
│                          └─────────────┘                        │
└─────────────────────────────────────────────────────────────────┘
```

**How it would work:**
1. FFmpeg captures screen, encodes H264, outputs raw packets
2. werift creates RTCPeerConnection in Bun
3. Watchdog's WebSocket server handles signaling
4. Viewer connects, exchanges SDP/ICE via our server
5. Media flows P2P or via configured TURN

**Pros:**
- Fully self-contained (no external binaries except FFmpeg)
- Full control over WebRTC parameters
- Uses our existing WebSocket infrastructure for signaling
- Can add custom TURN or use free public TURN servers

**Cons:**
- More complex implementation
- werift is less battle-tested than native WebRTC
- Need to handle FFmpeg → RTP packetization ourselves

---

### Option C: Hybrid Approach (Recommended)

Keep **webrtc-streamer** for local/simple use, add **VDO.ninja link generation** for remote.

**Architecture:**
```
                    ┌─────────────────────────────┐
                    │         Watchdog            │
                    │                             │
     Local ◄────────┤  webrtc-streamer (:8000)   │
     Viewer         │         +                   │
                    │  VDO.ninja integration      │────────► Remote
                    │  (generates share link)     │          Viewer
                    │                             │
                    └─────────────────────────────┘
```

**How VDO.ninja integration works:**

1. Watchdog embeds a headless browser (Puppeteer/Playwright)
2. Browser runs getDisplayMedia() to capture screen
3. Browser connects to VDO.ninja as publisher
4. Watchdog generates viewer link: `https://vdo.ninja/?view=wall-{wallId}`
5. Remote users open link - instant viewing, no setup

**Implementation:**
```javascript
// Simplified concept
const { chromium } = require('playwright');

async function startVdoNinjaStream(wallId) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Grant screen capture permission
  await page.context().grantPermissions(['camera', 'microphone']);

  // Navigate to VDO.ninja publisher page
  const roomId = `wall-${wallId}-${Date.now()}`;
  await page.goto(`https://vdo.ninja/?push=${roomId}&screenshare&autostart`);

  // Return viewer URL
  return `https://vdo.ninja/?view=${roomId}`;
}
```

**Pros:**
- Best of both worlds
- Local viewing stays fast (webrtc-streamer)
- Remote viewing "just works" (VDO.ninja)
- No port forwarding for remote
- Minimal new code

**Cons:**
- Adds Playwright/Puppeteer dependency (~200MB)
- Running headless browser uses more resources
- Two streaming systems

---

## Recommended: Option C (Hybrid)

### Why?

1. **Keeps existing functionality** - webrtc-streamer works great locally
2. **Solves remote access** - VDO.ninja handles NAT/firewall traversal
3. **Minimal complexity** - Just spawn a browser, no WebRTC implementation
4. **Battle-tested** - VDO.ninja handles thousands of streams daily
5. **Free** - No infrastructure costs

### Implementation Plan

#### Phase 1: Add Playwright for headless browser
```bash
bun add playwright
npx playwright install chromium
```

#### Phase 2: Create VDO.ninja streaming module

**New file: `src/vdo-ninja.ts`**

```typescript
import { chromium, Browser, Page } from 'playwright';

interface VdoNinjaState {
  status: 'stopped' | 'starting' | 'running' | 'error';
  viewerUrl: string | null;
  roomId: string | null;
  error: string | null;
}

let browser: Browser | null = null;
let page: Page | null = null;
let state: VdoNinjaState = { status: 'stopped', viewerUrl: null, roomId: null, error: null };

export async function startVdoNinja(wallId: string): Promise<string> {
  if (state.status === 'running') {
    return state.viewerUrl!;
  }

  state = { status: 'starting', viewerUrl: null, roomId: null, error: null };

  try {
    // Launch headless browser
    browser = await chromium.launch({
      headless: true,
      args: ['--use-fake-ui-for-media-stream'] // Auto-accept screen share
    });

    const context = await browser.newContext({
      permissions: ['camera', 'microphone']
    });

    page = await context.newPage();

    // Generate unique room ID
    const roomId = `vu-${wallId}-${Math.random().toString(36).slice(2, 8)}`;

    // Navigate to VDO.ninja with screen share auto-start
    const pushUrl = `https://vdo.ninja/?push=${roomId}&screenshare&autostart&quality=2`;
    await page.goto(pushUrl);

    // Wait for connection
    await page.waitForSelector('[data-action="hangup"]', { timeout: 30000 });

    const viewerUrl = `https://vdo.ninja/?view=${roomId}`;

    state = { status: 'running', viewerUrl, roomId, error: null };
    console.log(`[vdo-ninja] Streaming at: ${viewerUrl}`);

    return viewerUrl;

  } catch (err: any) {
    state = { status: 'error', viewerUrl: null, roomId: null, error: err.message };
    throw err;
  }
}

export async function stopVdoNinja(): Promise<void> {
  if (page) {
    await page.close();
    page = null;
  }
  if (browser) {
    await browser.close();
    browser = null;
  }
  state = { status: 'stopped', viewerUrl: null, roomId: null, error: null };
}

export function getVdoNinjaState(): VdoNinjaState {
  return { ...state };
}
```

#### Phase 3: Add API endpoints

**In `src/server.ts`:**

```typescript
// Start VDO.ninja remote streaming
if (url.pathname === "/api/remote-stream-start" && req.method === "POST") {
  const viewerUrl = await startVdoNinja(wallId);
  return jsonResponse({ ok: true, viewerUrl });
}

// Stop VDO.ninja remote streaming
if (url.pathname === "/api/remote-stream-stop" && req.method === "POST") {
  await stopVdoNinja();
  return jsonResponse({ ok: true });
}

// Get remote stream status
if (url.pathname === "/api/remote-stream-status" && req.method === "GET") {
  return jsonResponse(getVdoNinjaState());
}
```

#### Phase 4: Update dashboard UI

Add "Remote Streaming" section with:
- Start Remote Stream button
- Viewer URL (copyable)
- QR code for mobile viewing
- Stop button

#### Phase 5: Documentation

Update docs with:
- How remote streaming works
- Viewer instructions
- Bandwidth/quality considerations

---

## Alternative: Option B Deep Dive (If VDO.ninja dependency is unacceptable)

If we want fully self-hosted remote streaming without VDO.ninja:

### Required Components

1. **werift** - Pure JS WebRTC library
2. **FFmpeg** - Screen capture + H264 encoding
3. **Public TURN server** - For NAT traversal (can use free ones or self-host coturn)
4. **Signaling** - Our existing WebSocket server

### Implementation Complexity

| Component | Effort | Notes |
|-----------|--------|-------|
| FFmpeg → RTP bridge | High | Need to parse H264 NALUs, packetize to RTP |
| werift integration | Medium | Create peer connections, handle tracks |
| Signaling protocol | Low | SDP/ICE exchange over existing WS |
| TURN configuration | Low | Just config, can use free servers |
| Viewer page | Medium | Standard WebRTC client code |

**Total estimate**: 3-5 days of work vs 1 day for VDO.ninja integration

### Free Public TURN Servers

```javascript
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Metered.ca free tier (requires signup)
  {
    urls: 'turn:a.]relay.metered.ca:80',
    username: 'free-tier-username',
    credential: 'free-tier-password'
  }
]
```

---

## Decision Matrix

| Criteria | webrtc-streamer (current) | VDO.ninja (Option C) | werift (Option B) |
|----------|---------------------------|----------------------|-------------------|
| Local streaming | ✅ Works | ✅ Works | ✅ Works |
| Remote streaming | ⚠️ Needs port forward | ✅ Just works | ✅ With TURN |
| Setup complexity | Low | Low | High |
| Dependencies | 20MB binary | +200MB Playwright | +FFmpeg piping |
| External services | None | VDO.ninja servers | TURN server |
| Implementation time | Done | 1 day | 3-5 days |
| Control over quality | Limited | Medium | Full |

---

## Recommendation

**Start with Option C (VDO.ninja integration)** because:

1. Fastest path to working remote streaming
2. VDO.ninja is reliable, free, and widely used
3. Can always add Option B later if needed
4. Keeps existing webrtc-streamer for local use

### Next Steps

1. [ ] Install Playwright: `bun add playwright && npx playwright install chromium`
2. [ ] Create `src/vdo-ninja.ts` module
3. [ ] Add API endpoints for remote streaming
4. [ ] Update dashboard UI
5. [ ] Test remote viewing from phone/external network
6. [ ] Document usage

---

## Questions to Resolve

1. **Headless screen capture on Windows** - Does Playwright's headless mode support getDisplayMedia? May need headed mode with virtual display.

2. **Resource usage** - Running Chromium adds ~200-400MB RAM. Acceptable?

3. **Auto-reconnect** - If VDO.ninja connection drops, should we auto-restart?

4. **Quality settings** - VDO.ninja has quality presets (0-3). Which default?

5. **Multiple viewers** - VDO.ninja supports multiple viewers per stream. Document this?
