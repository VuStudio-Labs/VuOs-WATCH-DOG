/**
 * VDO.ninja Signaling Bridge
 *
 * Bridges webrtc-streamer's HTTP API to VDO.ninja's WebSocket signaling,
 * enabling remote viewing without port forwarding.
 */

const VDO_NINJA_WSS = "wss://wss.vdo.ninja:443";
const WEBRTC_STREAMER_URL = "http://localhost:8000";
const ICE_POLL_INTERVAL = 100; // ms

export interface VdoBridgeState {
  status: "disconnected" | "connecting" | "connected" | "error";
  roomId: string | null;
  viewerUrl: string | null;
  viewerCount: number;
  error: string | null;
}

interface ViewerConnection {
  uuid: string;
  peerId: string;
  connectedAt: number;
  icePollingInterval: Timer | null;
  iceCandidatesSent: Set<string>;
}

let ws: WebSocket | null = null;
let roomId: string | null = null;
let wallId: string | null = null;
let viewers: Map<string, ViewerConnection> = new Map();
let state: VdoBridgeState = {
  status: "disconnected",
  roomId: null,
  viewerUrl: null,
  viewerCount: 0,
  error: null,
};

// State change callback for broadcasting updates
let onStateChange: ((state: VdoBridgeState) => void) | null = null;

export function setStateChangeCallback(cb: (state: VdoBridgeState) => void): void {
  onStateChange = cb;
}

function updateState(updates: Partial<VdoBridgeState>): void {
  state = { ...state, ...updates };
  if (onStateChange) {
    onStateChange(state);
  }
}

export function getBridgeState(): VdoBridgeState {
  return { ...state, viewerCount: viewers.size };
}

/**
 * Start the VDO.ninja signaling bridge
 */
export async function startRemoteBridge(wId: string): Promise<string> {
  if (state.status === "connected" || state.status === "connecting") {
    if (state.viewerUrl) return state.viewerUrl;
    throw new Error("Bridge already starting");
  }

  // Verify webrtc-streamer is running
  try {
    const res = await fetch(`${WEBRTC_STREAMER_URL}/api/getMediaList`);
    if (!res.ok) throw new Error("webrtc-streamer not responding");
  } catch (err) {
    throw new Error("Local streaming must be running first");
  }

  wallId = wId;
  roomId = `vu-${wId}-${Date.now().toString(36)}`;
  const viewerUrl = `https://vdo.ninja/?view=${roomId}`;

  updateState({
    status: "connecting",
    roomId,
    viewerUrl,
    error: null,
  });

  return new Promise((resolve, reject) => {
    try {
      ws = new WebSocket(VDO_NINJA_WSS);

      const timeout = setTimeout(() => {
        if (state.status === "connecting") {
          ws?.close();
          updateState({ status: "error", error: "Connection timeout" });
          reject(new Error("VDO.ninja connection timeout"));
        }
      }, 10000);

      ws.onopen = () => {
        clearTimeout(timeout);
        console.log(`[vdo-bridge] Connected to VDO.ninja`);

        // Join room as publisher
        ws!.send(JSON.stringify({ join: roomId }));
        console.log(`[vdo-bridge] Joined room: ${roomId}`);

        updateState({ status: "connected" });
        resolve(viewerUrl);
      };

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          await handleMessage(msg);
        } catch (err) {
          console.error("[vdo-bridge] Message handling error:", err);
        }
      };

      ws.onerror = (error) => {
        clearTimeout(timeout);
        console.error("[vdo-bridge] WebSocket error:", error);
        updateState({ status: "error", error: "WebSocket connection failed" });
        reject(new Error("VDO.ninja connection failed"));
      };

      ws.onclose = (event) => {
        console.log(`[vdo-bridge] WebSocket closed: ${event.code}`);
        if (state.status === "connected") {
          // Unexpected close - clean up
          cleanupAllViewers();
          updateState({ status: "disconnected", roomId: null, viewerUrl: null });
        }
      };
    } catch (err) {
      updateState({ status: "error", error: String(err) });
      reject(err);
    }
  });
}

/**
 * Stop the VDO.ninja signaling bridge
 */
export async function stopRemoteBridge(): Promise<void> {
  console.log("[vdo-bridge] Stopping bridge...");

  // Clean up all viewer connections
  await cleanupAllViewers();

  // Close WebSocket
  if (ws) {
    ws.close(1000, "Bridge stopped");
    ws = null;
  }

  roomId = null;
  wallId = null;

  updateState({
    status: "disconnected",
    roomId: null,
    viewerUrl: null,
    viewerCount: 0,
    error: null,
  });

  console.log("[vdo-bridge] Bridge stopped");
}

/**
 * Handle incoming VDO.ninja messages
 */
async function handleMessage(msg: any): Promise<void> {
  // Debug logging
  if (msg.join || msg.request || msg.sdp || msg.candidate) {
    console.log("[vdo-bridge] Received:", JSON.stringify(msg).slice(0, 200));
  }

  // Viewer requesting an offer (wants to connect)
  if (msg.request === "offer" && msg.UUID) {
    await handleOfferRequest(msg.UUID);
    return;
  }

  // Viewer sent SDP answer
  if (msg.sdp?.type === "answer" && msg.UUID) {
    await handleAnswer(msg.UUID, msg.sdp);
    return;
  }

  // Viewer sent ICE candidate
  if (msg.candidate && msg.UUID) {
    await handleRemoteIce(msg.UUID, msg.candidate);
    return;
  }

  // Viewer disconnected
  if (msg.bye && msg.UUID) {
    await handleViewerDisconnect(msg.UUID);
    return;
  }
}

/**
 * Handle offer request from viewer - create peer connection and send offer
 */
async function handleOfferRequest(viewerUuid: string): Promise<void> {
  console.log(`[vdo-bridge] Viewer ${viewerUuid.slice(0, 8)} requesting offer`);

  const peerId = `viewer-${viewerUuid.slice(0, 8)}-${Date.now()}`;

  try {
    // Get SDP offer from webrtc-streamer
    const offerRes = await fetch(
      `${WEBRTC_STREAMER_URL}/api/call?peerid=${peerId}&url=screen://&options=rtptransport%3Dtcp`
    );

    if (!offerRes.ok) {
      console.error(`[vdo-bridge] Failed to get offer: ${offerRes.status}`);
      return;
    }

    const offer = await offerRes.json();
    console.log(`[vdo-bridge] Got offer for ${peerId}, sending to viewer`);

    // Send offer to viewer via VDO.ninja
    ws?.send(
      JSON.stringify({
        sdp: offer,
        UUID: viewerUuid,
      })
    );

    // Track viewer
    const viewer: ViewerConnection = {
      uuid: viewerUuid,
      peerId,
      connectedAt: Date.now(),
      icePollingInterval: null,
      iceCandidatesSent: new Set(),
    };

    // Start polling for local ICE candidates
    viewer.icePollingInterval = setInterval(async () => {
      await pollAndSendIce(viewer);
    }, ICE_POLL_INTERVAL);

    viewers.set(viewerUuid, viewer);
    updateState({ viewerCount: viewers.size });

    console.log(`[vdo-bridge] Viewer ${viewerUuid.slice(0, 8)} added (total: ${viewers.size})`);
  } catch (err) {
    console.error(`[vdo-bridge] Error handling offer request:`, err);
  }
}

/**
 * Handle SDP answer from viewer
 */
async function handleAnswer(viewerUuid: string, sdp: any): Promise<void> {
  const viewer = viewers.get(viewerUuid);
  if (!viewer) {
    console.warn(`[vdo-bridge] Answer from unknown viewer: ${viewerUuid.slice(0, 8)}`);
    return;
  }

  console.log(`[vdo-bridge] Received answer from viewer ${viewerUuid.slice(0, 8)}`);

  // webrtc-streamer accepts the answer via a POST to the same call endpoint
  // with the answer SDP in the body
  try {
    const answerRes = await fetch(
      `${WEBRTC_STREAMER_URL}/api/call?peerid=${viewer.peerId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sdp),
      }
    );

    if (!answerRes.ok) {
      console.error(`[vdo-bridge] Failed to set answer: ${answerRes.status}`);
    } else {
      console.log(`[vdo-bridge] Answer set for ${viewer.peerId}`);
    }
  } catch (err) {
    console.error(`[vdo-bridge] Error setting answer:`, err);
  }
}

/**
 * Poll webrtc-streamer for local ICE candidates and send to viewer
 */
async function pollAndSendIce(viewer: ViewerConnection): Promise<void> {
  try {
    const res = await fetch(
      `${WEBRTC_STREAMER_URL}/api/getIceCandidate?peerid=${viewer.peerId}`
    );

    if (!res.ok) return;

    const candidates = await res.json();

    for (const candidate of candidates) {
      // Deduplicate - don't send same candidate twice
      const candidateKey = candidate.candidate;
      if (viewer.iceCandidatesSent.has(candidateKey)) continue;
      viewer.iceCandidatesSent.add(candidateKey);

      ws?.send(
        JSON.stringify({
          candidate,
          UUID: viewer.uuid,
        })
      );
    }
  } catch (err) {
    // Ignore polling errors - connection may be closing
  }
}

/**
 * Handle ICE candidate from viewer
 */
async function handleRemoteIce(viewerUuid: string, candidate: any): Promise<void> {
  const viewer = viewers.get(viewerUuid);
  if (!viewer) return;

  try {
    await fetch(
      `${WEBRTC_STREAMER_URL}/api/addIceCandidate?peerid=${viewer.peerId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(candidate),
      }
    );
  } catch (err) {
    console.error(`[vdo-bridge] Error adding ICE candidate:`, err);
  }
}

/**
 * Handle viewer disconnect
 */
async function handleViewerDisconnect(viewerUuid: string): Promise<void> {
  const viewer = viewers.get(viewerUuid);
  if (!viewer) return;

  console.log(`[vdo-bridge] Viewer ${viewerUuid.slice(0, 8)} disconnected`);

  await cleanupViewer(viewer);
  viewers.delete(viewerUuid);
  updateState({ viewerCount: viewers.size });
}

/**
 * Clean up a single viewer connection
 */
async function cleanupViewer(viewer: ViewerConnection): Promise<void> {
  // Stop ICE polling
  if (viewer.icePollingInterval) {
    clearInterval(viewer.icePollingInterval);
    viewer.icePollingInterval = null;
  }

  // Hangup peer connection in webrtc-streamer
  try {
    await fetch(`${WEBRTC_STREAMER_URL}/api/hangup?peerid=${viewer.peerId}`, {
      method: "POST",
    });
  } catch (err) {
    // Ignore hangup errors
  }
}

/**
 * Clean up all viewer connections
 */
async function cleanupAllViewers(): Promise<void> {
  for (const [uuid, viewer] of viewers) {
    await cleanupViewer(viewer);
  }
  viewers.clear();
}
