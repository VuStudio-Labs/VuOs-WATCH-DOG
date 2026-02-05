/**
 * Screen capture streaming via webrtc-streamer
 *
 * Manages the webrtc-streamer process which:
 * - Captures the desktop via screen://
 * - Serves a WebRTC stream via built-in HTTP server
 * - Handles P2P WebRTC connections with STUN/TURN
 */

import { Subprocess } from "bun";
import * as path from "path";
import * as fs from "fs";
import { publishStreamStatus, clearStreamStatus as clearMqttStreamStatus, updateMainStatus } from "./mqtt";
import { getStreamerExe, areAssetsAvailable } from "./assets";

// Streaming state
export interface StreamingState {
  status: "stopped" | "starting" | "running" | "error";
  pid: number | null;
  port: number;
  startedAt: number | null;
  viewerUrl: string | null;
  error: string | null;
}

export interface StreamQuality {
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrate: number | null;
}

export interface StreamingConfig {
  port: number;           // HTTP port for webrtc-streamer (default 8000)
  stunServer: string;     // External STUN server for NAT traversal
  enableTurn: boolean;    // Enable embedded TURN server (deprecated, use turnServer instead)
  turnPort: number;       // TURN server port (for embedded TURN)
  turnServer: string | null; // External TURN server URL (e.g., "turn:user:pass@server:port")
  monitor: number | null; // Monitor index (0=first, 1=second, null=all)
  quality: StreamQuality; // Video quality settings
}

// Quality presets
export const QUALITY_PRESETS: Record<string, StreamQuality> = {
  low: { width: 1280, height: 720, fps: 15, bitrate: 1000 },
  medium: { width: 1920, height: 1080, fps: 30, bitrate: 3000 },
  high: { width: 1920, height: 1080, fps: 60, bitrate: 6000 },
};

// TURN server configuration
// Primary: Cloudflare TURN (via Vu Studio API)
// Fallback: Metered.ca TURN (Vu Studio account)
// Backup: Open Relay Project (free public)

const CLOUDFLARE_TURN_KEY = "432338ab38bdf2583e26996c3b9ff488";
const CLOUDFLARE_API_KEY = "6c6bb64b5e4030fb5873f85155c19a8a4675d056a1b84a0c27476be011215c28";
const METERED_KEY = "x5temSYro_2G91kS2O9YLshdKL5jD68CBfzgg1J7vUBe32Kq";

// Fallback public TURN (Open Relay Project)
const PUBLIC_TURN_SERVER = "turn:openrelayproject:openrelayproject@a.relay.metered.ca:80";

interface TurnCredentials {
  urls: string[];
  username: string;
  credential: string;
}

/**
 * Fetch TURN credentials from Cloudflare (primary)
 */
async function getCloudfareTurnCredentials(): Promise<TurnCredentials | null> {
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${CLOUDFLARE_TURN_KEY}/credentials/generate`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${CLOUDFLARE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 86400 }), // 24 hour TTL
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Cloudflare returns iceServers array
    if (data.iceServers?.[0]) {
      const server = data.iceServers[0];
      return {
        urls: server.urls || [`turn:turn.vu.studio:3478`],
        username: server.username,
        credential: server.credential,
      };
    }
    return null;
  } catch (err: any) {
    console.log(`[streaming] Cloudflare TURN failed: ${err.message}`);
    return null;
  }
}

/**
 * Fetch TURN credentials from Metered (fallback)
 */
async function getMeteredTurnCredentials(): Promise<TurnCredentials | null> {
  try {
    const res = await fetch(
      `https://vustudio.metered.live/api/v1/turn/credential?secretKey=${METERED_KEY}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Metered returns array of credentials
    if (Array.isArray(data) && data.length > 0) {
      return {
        urls: data.map((c: any) => c.urls || c.url).flat().filter(Boolean),
        username: data[0].username,
        credential: data[0].credential,
      };
    }
    return null;
  } catch (err: any) {
    console.log(`[streaming] Metered TURN failed: ${err.message}`);
    return null;
  }
}

/**
 * Get TURN server URL with credentials (tries Cloudflare → Metered → Public)
 */
async function getTurnServerUrl(): Promise<string> {
  // Try Cloudflare first
  const cfCreds = await getCloudfareTurnCredentials();
  if (cfCreds && cfCreds.username && cfCreds.credential) {
    const url = cfCreds.urls[0] || "turn:turn.vu.studio:3478";
    const host = url.replace(/^turns?:/, "").split("?")[0];
    console.log(`[streaming] Using Cloudflare TURN: ${host}`);
    return `turn:${cfCreds.username}:${cfCreds.credential}@${host}`;
  }

  // Try Metered fallback
  const meteredCreds = await getMeteredTurnCredentials();
  if (meteredCreds && meteredCreds.username && meteredCreds.credential) {
    const url = meteredCreds.urls[0] || "turn:a.relay.metered.ca:80";
    const host = url.replace(/^turns?:/, "").split("?")[0];
    console.log(`[streaming] Using Metered TURN: ${host}`);
    return `turn:${meteredCreds.username}:${meteredCreds.credential}@${host}`;
  }

  // Fallback to public TURN
  console.log(`[streaming] Using public TURN fallback`);
  return PUBLIC_TURN_SERVER;
}

const DEFAULT_CONFIG: StreamingConfig = {
  port: 8000,
  stunServer: "stun:stun.l.google.com:19302",
  enableTurn: true,       // Embedded TURN for server-side relay candidates
  turnPort: 3478,
  turnServer: null,
  monitor: 0,             // Default to primary monitor only
  quality: QUALITY_PRESETS.medium,
};

// Ports to try if default is busy
const HTTP_FALLBACK_PORTS = [8000, 8001, 8002, 8003, 8080, 8888];
const TURN_FALLBACK_PORTS = [3478, 3479, 3480, 3481];

/**
 * Get the local IP address for TURN server external address
 */
function getLocalIp(): string {
  try {
    const { networkInterfaces } = require("os");
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        // Skip internal/loopback and IPv6
        if (!net.internal && net.family === "IPv4") {
          return net.address;
        }
      }
    }
  } catch {}
  return "127.0.0.1";
}

/**
 * Check if a TCP port is available
 */
async function isPortAvailable(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({
      port,
      fetch() { return new Response("ok"); },
    });
    server.stop();
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an available HTTP port
 */
async function findAvailableHttpPort(): Promise<number | null> {
  for (const port of HTTP_FALLBACK_PORTS) {
    if (await isPortAvailable(port)) {
      return port;
    }
    console.log(`[streaming] HTTP port ${port} is busy, trying next...`);
  }
  return null;
}

/**
 * Find an available TURN port
 */
async function findAvailableTurnPort(): Promise<number | null> {
  for (const port of TURN_FALLBACK_PORTS) {
    if (await isPortAvailable(port)) {
      return port;
    }
    console.log(`[streaming] TURN port ${port} is busy, trying next...`);
  }
  return null;
}

let streamerProcess: Subprocess | null = null;
let currentState: StreamingState = {
  status: "stopped",
  pid: null,
  port: DEFAULT_CONFIG.port,
  startedAt: null,
  viewerUrl: null,
  error: null,
};
let currentConfig = DEFAULT_CONFIG;
let activeWallId: string | null = null;

/**
 * Set the wall ID for MQTT publishing
 */
export function setStreamingWallId(wallId: string): void {
  activeWallId = wallId;
}

/**
 * Publish initial stopped status to clear stale retained messages (call after MQTT connects)
 */
export function publishInitialStreamStatus(): void {
  if (!activeWallId) return;
  publishStatus();
  updateMainStatus(activeWallId, "stopped");
}

/**
 * Publish current streaming status to MQTT
 */
function publishStatus(): void {
  if (!activeWallId) return;
  publishStreamStatus(activeWallId, {
    ...currentState,
    monitor: currentConfig.monitor,
    quality: currentConfig.quality,
    available: isStreamerAvailable(),
  });
}

/**
 * Clear retained stream status (prevents stale messages)
 */
function clearStreamStatus(): void {
  if (!activeWallId) return;
  clearMqttStreamStatus(activeWallId);
}

/**
 * Check if webrtc-streamer binary exists
 */
export function isStreamerAvailable(): boolean {
  return areAssetsAvailable();
}

/**
 * Get current streaming state
 */
export function getStreamingState(): StreamingState {
  // Update uptime if running
  if (currentState.status === "running" && streamerProcess) {
    // Check if process is still running
    if (streamerProcess.exitCode !== null) {
      currentState.status = "stopped";
      currentState.pid = null;
      currentState.startedAt = null;
      currentState.viewerUrl = null;
      streamerProcess = null;
    }
  }
  return { ...currentState };
}

/**
 * Start screen capture streaming
 */
export async function startStreaming(config?: Partial<StreamingConfig>): Promise<void> {
  // Auto-stop any existing stream first
  if (currentState.status === "running" || currentState.status === "starting" || streamerProcess) {
    console.log("[streaming] Stopping existing stream first...");
    await stopStreaming();
    // Wait for port to be released
    await new Promise(r => setTimeout(r, 1000));
  }

  // Kill any zombie webrtc-streamer processes from previous sessions
  try {
    Bun.spawnSync(["taskkill", "/F", "/IM", "webrtc-streamer.exe"], { stdio: ["ignore", "ignore", "ignore"] });
    // Wait longer for ports to be released
    await new Promise(r => setTimeout(r, 1500));
  } catch {}

  const streamerExe = getStreamerExe();

  if (!streamerExe) {
    throw new Error(`webrtc-streamer not found. Run: bun scripts/download-webrtc-streamer.ts`);
  }

  currentConfig = { ...DEFAULT_CONFIG, ...config };

  // Find available HTTP port
  const requestedPort = currentConfig.port;
  const availablePort = await findAvailableHttpPort();

  if (!availablePort) {
    throw new Error(`No available HTTP ports found. Tried: ${HTTP_FALLBACK_PORTS.join(", ")}`);
  }

  if (availablePort !== requestedPort) {
    console.log(`[streaming] Port ${requestedPort} busy, using ${availablePort}`);
  }

  currentConfig.port = availablePort;

  // Find available TURN port if enabled
  if (currentConfig.enableTurn) {
    const requestedTurnPort = currentConfig.turnPort;
    const availableTurnPort = await findAvailableTurnPort();

    if (!availableTurnPort) {
      console.warn(`[streaming] No TURN ports available, disabling TURN`);
      currentConfig.enableTurn = false;
    } else {
      if (availableTurnPort !== requestedTurnPort) {
        console.log(`[streaming] TURN port ${requestedTurnPort} busy, using ${availableTurnPort}`);
      }
      currentConfig.turnPort = availableTurnPort;
    }
  }

  currentState = {
    status: "starting",
    pid: null,
    port: currentConfig.port,
    startedAt: null,
    viewerUrl: null,
    error: null,
  };

  console.log("[streaming] Starting webrtc-streamer...");

  try {
    // Build screen capture URL (screen:// for all, screen://N for specific monitor)
    const screenUrl = currentConfig.monitor !== null
      ? `screen://${currentConfig.monitor}`
      : "screen://";

    // Build command line arguments
    const args: string[] = [
      "-H", `0.0.0.0:${currentConfig.port}`,        // HTTP binding (for WebRTC API)
      "-s", currentConfig.stunServer,                // STUN server for NAT traversal
      "-n", "desktop",                               // Stream name
      "-u", screenUrl,                               // Capture screen (specific monitor or all)
    ];

    // Enable embedded TURN server for server-side relay candidates
    if (currentConfig.enableTurn) {
      const localIp = getLocalIp();
      console.log(`[streaming] Embedded TURN on ${localIp}:${currentConfig.turnPort}`);
      args.push("-T", `turn:turn@${localIp}:${currentConfig.turnPort}`);
    }

    // Note: Quality settings (width/fps/bitrate) not supported by this webrtc-streamer version
    // Quality is controlled by the source capture settings, not CLI args

    console.log(`[streaming] Command: ${streamerExe} ${args.join(" ")}`);

    streamerProcess = Bun.spawn([streamerExe, ...args], {
      cwd: path.dirname(streamerExe),
      stdio: ["ignore", "pipe", "pipe"],
    });

    currentState.pid = streamerProcess.pid;

    // Read stdout/stderr for logging
    const readOutput = async (stream: ReadableStream<Uint8Array>, prefix: string) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value).trim();
        if (text) {
          for (const line of text.split("\n")) {
            console.log(`[streaming] ${prefix}: ${line}`);
          }
        }
      }
    };

    // Start reading output in background
    readOutput(streamerProcess.stdout, "stdout");
    readOutput(streamerProcess.stderr, "stderr");

    // Wait for server to be ready (check if port is listening)
    await waitForPort(currentConfig.port, 10000);

    currentState.status = "running";
    currentState.startedAt = Date.now();
    currentState.viewerUrl = `http://localhost:${currentConfig.port}/webrtcstreamer.html?video=desktop`;

    console.log(`[streaming] Started on port ${currentConfig.port}`);
    console.log(`[streaming] Viewer URL: ${currentState.viewerUrl}`);
    publishStatus();
    // Update main status topic to keep stream state in sync
    if (activeWallId) updateMainStatus(activeWallId, "running");

    // Monitor process exit
    streamerProcess.exited.then((exitCode) => {
      console.log(`[streaming] Process exited with code ${exitCode}`);
      if (currentState.status === "running") {
        currentState.status = "stopped";
        currentState.pid = null;
        currentState.startedAt = null;
        currentState.viewerUrl = null;
      }
      streamerProcess = null;
    });

  } catch (err: any) {
    currentState.status = "error";
    currentState.error = err.message;
    console.error("[streaming] Failed to start:", err.message);
    throw err;
  }
}

/**
 * Stop screen capture streaming
 */
export async function stopStreaming(): Promise<void> {
  if (!streamerProcess) {
    currentState.status = "stopped";
    return;
  }

  console.log("[streaming] Stopping...");

  try {
    // Kill the process
    streamerProcess.kill();

    // Wait for exit with timeout
    const timeout = setTimeout(() => {
      if (streamerProcess) {
        streamerProcess.kill(9); // Force kill
      }
    }, 5000);

    await streamerProcess.exited;
    clearTimeout(timeout);

  } catch (err: any) {
    console.error("[streaming] Error stopping:", err.message);
  }

  streamerProcess = null;
  currentState = {
    status: "stopped",
    pid: null,
    port: currentConfig.port,
    startedAt: null,
    viewerUrl: null,
    error: null,
  };

  console.log("[streaming] Stopped");
  // Publish stopped status (overwrites any stale "running" retained message)
  publishStatus();
  // Update main status topic to keep stream state in sync
  if (activeWallId) updateMainStatus(activeWallId, "stopped");
}

/**
 * Get the viewer URL for external access
 */
export function getViewerUrl(host?: string): string | null {
  if (currentState.status !== "running") return null;
  const baseHost = host || `localhost:${currentState.port}`;
  return `http://${baseHost}/webrtcstreamer.html?video=desktop`;
}

/**
 * Get streaming uptime in seconds
 */
export function getUptime(): number | null {
  if (!currentState.startedAt) return null;
  return Math.floor((Date.now() - currentState.startedAt) / 1000);
}

/**
 * Wait for a port to be available
 */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://localhost:${port}/`, {
        signal: AbortSignal.timeout(1000)
      });
      if (response.ok || response.status === 404) {
        return; // Server is responding
      }
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for port ${port}`);
}

/**
 * Cleanup on process exit
 */
export function cleanup() {
  if (streamerProcess) {
    console.log("[streaming] Cleanup: stopping streamer");
    streamerProcess.kill();
    streamerProcess = null;
  }
  // Clear retained status on graceful shutdown
  clearStreamStatus();
}
