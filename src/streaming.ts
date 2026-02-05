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
import { getStreamerExe, getHtmlDir, areAssetsAvailable } from "./assets";

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
  enableTurn: boolean;    // Enable embedded TURN server
  turnPort: number;       // TURN server port
  monitor: number | null; // Monitor index (0=first, 1=second, null=all)
  quality: StreamQuality; // Video quality settings
}

// Quality presets
export const QUALITY_PRESETS: Record<string, StreamQuality> = {
  low: { width: 1280, height: 720, fps: 15, bitrate: 1000 },
  medium: { width: 1920, height: 1080, fps: 30, bitrate: 3000 },
  high: { width: 1920, height: 1080, fps: 60, bitrate: 6000 },
};

const DEFAULT_CONFIG: StreamingConfig = {
  port: 8000,
  stunServer: "stun:stun.l.google.com:19302",
  enableTurn: true,
  turnPort: 3478,
  monitor: 0,             // Default to primary monitor only
  quality: QUALITY_PRESETS.medium,
};

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
    await new Promise(r => setTimeout(r, 500));
  } catch {}

  const streamerExe = getStreamerExe();
  const htmlDir = getHtmlDir();

  if (!streamerExe || !htmlDir) {
    throw new Error(`webrtc-streamer not found. Run: bun scripts/download-webrtc-streamer.ts`);
  }

  currentConfig = { ...DEFAULT_CONFIG, ...config };
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
      "-H", `0.0.0.0:${currentConfig.port}`,        // HTTP binding
      "-w", htmlDir,                                 // Web root for viewer
      "-s", currentConfig.stunServer,                // STUN server for NAT traversal
      "-n", "desktop",                               // Stream name
      "-u", screenUrl,                               // Capture screen (specific monitor or all)
    ];

    // Enable embedded TURN server for remote access through NAT
    if (currentConfig.enableTurn) {
      args.push("-T", `turn:turn@0.0.0.0:${currentConfig.turnPort}`);
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
