/**
 * Remote Viewing Bridge
 *
 * Connects webrtc-streamer to remote viewers via MQTT signaling.
 * Uses existing MQTT connection from watchdog.
 */

import { getActiveClient, TOPICS } from "./mqtt";
import type { MqttClient } from "mqtt";

const WEBRTC_STREAMER_URL = "http://localhost:8000";
const ICE_POLL_INTERVAL = 100;

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
    const res = await fetch(`${WEBRTC_STREAMER_URL}/api/getMediaList`);
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

  // Publish that we're ready
  mqttClient.publish(
    WEBRTC_TOPICS.offer(wallId),
    JSON.stringify({ type: "ready", from: myId, wallId }),
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

  const peerId = `peer-${viewerId.slice(0, 8)}-${Date.now()}`;

  try {
    // Get offer from webrtc-streamer
    const res = await fetch(
      `${WEBRTC_STREAMER_URL}/api/createOffer?peerid=${peerId}&url=desktop`
    );

    if (!res.ok) {
      console.error(`[remote-bridge] Failed to create offer: ${res.status}`);
      return;
    }

    const offer = await res.json();
    console.log(`[remote-bridge] Sending offer to ${viewerId.slice(0, 8)}`);

    // Send offer via MQTT
    mqttClient.publish(
      WEBRTC_TOPICS.offer(wallId),
      JSON.stringify({
        type: "offer",
        description: offer,
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
    };

    // Poll for ICE candidates
    viewer.icePollingInterval = setInterval(() => pollIce(viewer), ICE_POLL_INTERVAL);

    viewers.set(viewerId, viewer);
    updateState({ viewerCount: viewers.size });

  } catch (err) {
    console.error("[remote-bridge] Error handling viewer:", err);
  }
}

async function handleAnswer(viewerId: string, sdp: any): Promise<void> {
  const viewer = viewers.get(viewerId);
  if (!viewer) return;

  console.log(`[remote-bridge] Answer from ${viewerId.slice(0, 8)}`);

  try {
    await fetch(
      `${WEBRTC_STREAMER_URL}/api/setAnswer?peerid=${viewer.peerId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sdp),
      }
    );
  } catch (err) {
    console.error("[remote-bridge] Error setting answer:", err);
  }
}

async function pollIce(viewer: ViewerConnection): Promise<void> {
  if (!mqttClient || !wallId) return;

  try {
    const res = await fetch(
      `${WEBRTC_STREAMER_URL}/api/getIceCandidate?peerid=${viewer.peerId}`
    );
    if (!res.ok) return;

    const candidates = await res.json();

    for (const candidate of candidates) {
      const key = candidate.candidate;
      if (viewer.iceCandidatesSent.has(key)) continue;
      viewer.iceCandidatesSent.add(key);

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
  } catch {
    // Ignore
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
    await fetch(`${WEBRTC_STREAMER_URL}/api/hangup?peerid=${viewer.peerId}`, {
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
