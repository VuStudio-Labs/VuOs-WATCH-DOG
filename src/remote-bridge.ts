/**
 * Remote Viewing Bridge
 *
 * Connects webrtc-streamer to remote viewers via MQTT signaling.
 * Uses existing MQTT connection from watchdog.
 */

import { getActiveClient, TOPICS } from "./mqtt";
import { getStreamingState, getIceServers } from "./streaming";
import type { MqttClient } from "mqtt";

// Get the current streamer URL based on streaming port
function getStreamerUrl(): string {
  const state = getStreamingState();
  return `http://localhost:${state.port}`;
}
const ICE_POLL_INTERVAL = 200; // Poll ICE candidates every 200ms
const VIEWER_JOIN_DEBOUNCE = 2000; // Ignore rapid rejoins within 2s

export interface RemoteBridgeState {
  status: "disconnected" | "connecting" | "connected" | "error";
  roomId: string | null;
  viewerUrl: string | null;
  viewerCount: number;
  error: string | null;
}

interface ViewerConnection {
  id: string;
  peerId: string;
  connectedAt: number;
  icePollingInterval: Timer | null;
  iceCandidatesSent: Set<string>;
  answerReceived: boolean;
}

// MQTT topics for WebRTC signaling
const WEBRTC_TOPICS = {
  // Publisher sends offer here, viewers subscribe
  offer: (wallId: string) => `watchdog/${wallId}/webrtc/offer`,
  // Viewers send answers here, publisher subscribes
  answer: (wallId: string) => `watchdog/${wallId}/webrtc/answer`,
  // ICE candidates (bidirectional)
  ice: (wallId: string) => `watchdog/${wallId}/webrtc/ice`,
  // Viewer presence
  join: (wallId: string) => `watchdog/${wallId}/webrtc/join`,
  leave: (wallId: string) => `watchdog/${wallId}/webrtc/leave`,
};

let wallId: string | null = null;
let roomId: string | null = null;
let myId: string | null = null;
let viewers = new Map<string, ViewerConnection>();
let recentJoins = new Map<string, number>(); // Track join timestamps to debounce
let mqttClient: MqttClient | null = null;

let state: RemoteBridgeState = {
  status: "disconnected",
  roomId: null,
  viewerUrl: null,
  viewerCount: 0,
  error: null,
};

let onStateChange: ((state: RemoteBridgeState) => void) | null = null;

export function setRemoteStateChangeCallback(cb: (state: RemoteBridgeState) => void): void {
  onStateChange = cb;
}

function updateState(updates: Partial<RemoteBridgeState>): void {
  state = { ...state, ...updates };
  onStateChange?.(state);
}

export function getRemoteBridgeState(): RemoteBridgeState {
  return { ...state, viewerCount: viewers.size };
}

/**
 * Start the remote viewing bridge
 */
export async function startRemoteViewing(wId: string): Promise<string> {
  if (state.status === "connected" || state.status === "connecting") {
    if (state.viewerUrl) return state.viewerUrl;
    throw new Error("Bridge already starting");
  }

  // Get MQTT client
  mqttClient = getActiveClient();
  if (!mqttClient || !mqttClient.connected) {
    throw new Error("MQTT not connected");
  }

  // Verify webrtc-streamer is running
  try {
    const res = await fetch(`${getStreamerUrl()}/api/getMediaList`);
    if (!res.ok) throw new Error("webrtc-streamer not responding");
  } catch (err) {
    throw new Error("Local streaming must be running first");
  }

  wallId = wId;
  roomId = wId; // Use wallId as room for simplicity
  myId = `pub-${Date.now().toString(36)}`;

  // Viewer URL - your app will provide the actual viewer
  const viewerUrl = `https://your-viewer.com/?wall=${wallId}`;

  updateState({
    status: "connecting",
    roomId,
    viewerUrl,
    error: null,
  });

  // Subscribe to viewer messages
  const topics = [
    WEBRTC_TOPICS.join(wallId),
    WEBRTC_TOPICS.answer(wallId),
    WEBRTC_TOPICS.ice(wallId),
    WEBRTC_TOPICS.leave(wallId),
  ];

  mqttClient.subscribe(topics, { qos: 1 }, (err) => {
    if (err) {
      console.error("[remote-bridge] Subscribe error:", err);
      updateState({ status: "error", error: "Failed to subscribe" });
      return;
    }
    console.log(`[remote-bridge] Subscribed to WebRTC topics for wall ${wallId}`);
    updateState({ status: "connected" });
  });

  // Handle incoming messages
  mqttClient.on("message", handleMqttMessage);

  // Publish that we're ready (include iceServers so viewers can configure before first offer)
  mqttClient.publish(
    WEBRTC_TOPICS.offer(wallId),
    JSON.stringify({ type: "ready", from: myId, wallId, iceServers: getIceServers() }),
    { qos: 1, retain: true }
  );

  console.log(`[remote-bridge] Started for wall ${wallId}`);
  return viewerUrl;
}

/**
 * Stop remote viewing
 */
export async function stopRemoteViewing(): Promise<void> {
  console.log("[remote-bridge] Stopping...");

  if (mqttClient && wallId) {
    // Unsubscribe
    const topics = [
      WEBRTC_TOPICS.join(wallId),
      WEBRTC_TOPICS.answer(wallId),
      WEBRTC_TOPICS.ice(wallId),
      WEBRTC_TOPICS.leave(wallId),
    ];
    mqttClient.unsubscribe(topics);

    // Clear retained offer (empty string clears retained message)
    mqttClient.publish(WEBRTC_TOPICS.offer(wallId), "", { retain: true, qos: 1 });

    mqttClient.removeListener("message", handleMqttMessage);
  }

  await cleanupAllViewers();
  recentJoins.clear();

  wallId = null;
  roomId = null;
  myId = null;
  mqttClient = null;

  updateState({
    status: "disconnected",
    roomId: null,
    viewerUrl: null,
    viewerCount: 0,
    error: null,
  });
}

function handleMqttMessage(topic: string, payload: Buffer): void {
  if (!wallId) return;

  try {
    const msg = JSON.parse(payload.toString());

    // Ignore our own messages
    if (msg.from === myId) return;

    const viewerId = msg.from;
    if (!viewerId) return;

    // Viewer wants to join
    if (topic === WEBRTC_TOPICS.join(wallId)) {
      console.log(`[remote-bridge] Viewer ${viewerId.slice(0, 8)} joining`);
      handleViewerJoin(viewerId);
      return;
    }

    // Viewer sent answer
    if (topic === WEBRTC_TOPICS.answer(wallId) && msg.description?.type === "answer") {
      handleAnswer(viewerId, msg.description);
      return;
    }

    // ICE candidate
    if (topic === WEBRTC_TOPICS.ice(wallId) && msg.candidate) {
      // Check if it's for us (from a viewer)
      if (msg.to === myId || !msg.to) {
        handleRemoteIce(viewerId, msg.candidate);
      }
      return;
    }

    // Viewer left
    if (topic === WEBRTC_TOPICS.leave(wallId)) {
      handleViewerLeave(viewerId);
      return;
    }
  } catch (e) {
    // Ignore parse errors
  }
}

async function handleViewerJoin(viewerId: string): Promise<void> {
  if (!mqttClient || !wallId) return;

  // Debounce rapid rejoins from same viewer
  const lastJoin = recentJoins.get(viewerId);
  const now = Date.now();
  if (lastJoin && now - lastJoin < VIEWER_JOIN_DEBOUNCE) {
    console.log(`[remote-bridge] Ignoring rapid rejoin from ${viewerId.slice(0, 8)} (${now - lastJoin}ms ago)`);
    return;
  }
  recentJoins.set(viewerId, now);

  // Check if streaming is running
  const streamState = getStreamingState();
  if (streamState.status !== "running") {
    console.log(`[remote-bridge] Ignoring join - stream is ${streamState.status}`);
    return;
  }

  // If viewer already exists, clean up old connection first
  const existingViewer = viewers.get(viewerId);
  if (existingViewer) {
    console.log(`[remote-bridge] Cleaning up existing connection for ${viewerId.slice(0, 8)}`);
    await cleanupViewer(existingViewer);
    viewers.delete(viewerId);
  }

  const peerId = `peer-${viewerId.slice(0, 8)}-${Date.now()}`;
  const streamerUrl = getStreamerUrl();

  try {
    // Get offer from webrtc-streamer with retry
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(
          `${streamerUrl}/api/createOffer?peerid=${peerId}&url=desktop`,
          { signal: AbortSignal.timeout(2000) }
        );
        if (res.ok) break;
      } catch {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }

    if (!res || !res.ok) {
      console.error(`[remote-bridge] Failed to create offer after retries`);
      return;
    }

    const offer = await res.json();
    console.log(`[remote-bridge] Created offer for ${viewerId.slice(0, 8)}:`, {
      type: offer.type,
      sdpLength: offer.sdp?.length || 0,
      hasVideo: offer.sdp?.includes("m=video"),
      hasAudio: offer.sdp?.includes("m=audio"),
    });

    // Send offer via MQTT (include iceServers so viewer uses same STUN/TURN as sender)
    mqttClient.publish(
      WEBRTC_TOPICS.offer(wallId),
      JSON.stringify({
        type: "offer",
        description: offer,
        iceServers: getIceServers(),
        to: viewerId,
        from: myId,
      }),
      { qos: 1 }
    );

    // Track viewer
    const viewer: ViewerConnection = {
      id: viewerId,
      peerId,
      connectedAt: Date.now(),
      icePollingInterval: null,
      iceCandidatesSent: new Set(),
      answerReceived: false,
    };

    // Poll for ICE candidates
    viewer.icePollingInterval = setInterval(() => pollIce(viewer), ICE_POLL_INTERVAL);

    // Stop ICE polling after 30s to prevent resource leak
    setTimeout(() => {
      if (viewer.icePollingInterval) {
        console.log(`[remote-bridge] Stopping ICE polling for ${viewerId.slice(0, 8)} after timeout`);
        clearInterval(viewer.icePollingInterval);
        viewer.icePollingInterval = null;
      }
    }, 30000);

    viewers.set(viewerId, viewer);
    updateState({ viewerCount: viewers.size });
    console.log(`[remote-bridge] Viewer ${viewerId.slice(0, 8)} connection setup complete, waiting for answer`);

  } catch (err) {
    console.error("[remote-bridge] Error handling viewer:", err);
  }
}

async function handleAnswer(viewerId: string, sdp: any): Promise<void> {
  const viewer = viewers.get(viewerId);
  if (!viewer) {
    console.log(`[remote-bridge] Answer from unknown viewer ${viewerId.slice(0, 8)}, ignoring`);
    return;
  }

  if (viewer.answerReceived) {
    console.log(`[remote-bridge] Duplicate answer from ${viewerId.slice(0, 8)}, ignoring`);
    return;
  }

  console.log(`[remote-bridge] Answer from ${viewerId.slice(0, 8)}, setting on peer ${viewer.peerId}`);
  viewer.answerReceived = true;

  try {
    const res = await fetch(
      `${getStreamerUrl()}/api/setAnswer?peerid=${viewer.peerId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sdp),
      }
    );
    if (res.ok) {
      console.log(`[remote-bridge] Answer applied successfully for ${viewerId.slice(0, 8)}`);
    } else {
      console.error(`[remote-bridge] setAnswer failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error("[remote-bridge] Error setting answer:", err);
  }
}

async function pollIce(viewer: ViewerConnection): Promise<void> {
  if (!mqttClient || !wallId) return;

  try {
    const res = await fetch(
      `${getStreamerUrl()}/api/getIceCandidate?peerid=${viewer.peerId}`
    );
    if (!res.ok) return;

    const candidates = await res.json();

    for (const candidate of candidates) {
      const key = candidate.candidate;
      if (viewer.iceCandidatesSent.has(key)) continue;
      viewer.iceCandidatesSent.add(key);

      // Log first few ICE candidates for debugging
      if (viewer.iceCandidatesSent.size <= 3) {
        const type = key.includes("typ host") ? "host" :
                     key.includes("typ srflx") ? "srflx" :
                     key.includes("typ relay") ? "relay" : "unknown";
        console.log(`[remote-bridge] Sending ICE ${type} candidate to ${viewer.id.slice(0, 8)}`);
      }

      mqttClient.publish(
        WEBRTC_TOPICS.ice(wallId),
        JSON.stringify({
          candidate,
          to: viewer.id,
          from: myId,
        }),
        { qos: 1 }
      );
    }
  } catch {
    // Ignore
  }
}

async function handleRemoteIce(viewerId: string, candidate: any): Promise<void> {
  const viewer = viewers.get(viewerId);
  if (!viewer) {
    console.log(`[remote-bridge] ICE from unknown viewer ${viewerId.slice(0, 8)}, ignoring`);
    return;
  }

  const candidateStr = candidate?.candidate || "";
  const type = candidateStr.includes("typ host") ? "host" :
               candidateStr.includes("typ srflx") ? "srflx" :
               candidateStr.includes("typ relay") ? "relay" : "unknown";
  console.log(`[remote-bridge] Received ICE ${type} candidate from ${viewerId.slice(0, 8)}`);

  try {
    const res = await fetch(
      `${getStreamerUrl()}/api/addIceCandidate?peerid=${viewer.peerId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(candidate),
      }
    );
    if (!res.ok) {
      console.error(`[remote-bridge] addIceCandidate failed: ${res.status}`);
    }
  } catch (err) {
    console.error(`[remote-bridge] Error adding ICE candidate:`, err);
  }
}

async function handleViewerLeave(viewerId: string): Promise<void> {
  const viewer = viewers.get(viewerId);
  if (!viewer) return;

  console.log(`[remote-bridge] Viewer ${viewerId.slice(0, 8)} left`);
  await cleanupViewer(viewer);
  viewers.delete(viewerId);
  updateState({ viewerCount: viewers.size });
}

async function cleanupViewer(viewer: ViewerConnection): Promise<void> {
  if (viewer.icePollingInterval) {
    clearInterval(viewer.icePollingInterval);
  }

  try {
    await fetch(`${getStreamerUrl()}/api/hangup?peerid=${viewer.peerId}`, {
      method: "POST",
    });
  } catch {}
}

async function cleanupAllViewers(): Promise<void> {
  for (const viewer of viewers.values()) {
    await cleanupViewer(viewer);
  }
  viewers.clear();
}
