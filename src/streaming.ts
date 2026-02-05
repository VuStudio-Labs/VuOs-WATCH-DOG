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

// Streaming state
export interface StreamingState {
  status: "stopped" | "starting" | "running" | "error";
  pid: number | null;
  port: number;
  startedAt: number | null;
  viewerUrl: string | null;
  error: string | null;
}

export interface StreamingConfig {
  port: number;           // HTTP port for webrtc-streamer (default 8000)
  stunServer: string;     // External STUN server for NAT traversal
  enableTurn: boolean;    // Enable embedded TURN server
  turnPort: number;       // TURN server port
}

const DEFAULT_CONFIG: StreamingConfig = {
  port: 8000,
  stunServer: "stun:stun.l.google.com:19302",
  enableTurn: true,
  turnPort: 3478,
};

// Find webrtc-streamer binary
const BIN_DIR = path.join(import.meta.dir, "..", "bin");
const STREAMER_EXE = path.join(BIN_DIR, "webrtc-streamer.exe");
const HTML_DIR = path.join(BIN_DIR, "html");

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

/**
 * Check if webrtc-streamer binary exists
 */
export function isStreamerAvailable(): boolean {
  return fs.existsSync(STREAMER_EXE);
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
  if (currentState.status === "running" || currentState.status === "starting") {
    throw new Error("Streaming already active");
  }

  if (!isStreamerAvailable()) {
    throw new Error(`webrtc-streamer not found at ${STREAMER_EXE}. Run: bun scripts/download-webrtc-streamer.ts`);
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
    // Build command line arguments
    const args: string[] = [
      "-H", `0.0.0.0:${currentConfig.port}`,        // HTTP binding
      "-w", HTML_DIR,                                // Web root for viewer
      "-s", currentConfig.stunServer,                // STUN server for NAT traversal
      "-n", "desktop",                               // Stream name
      "-u", "screen://",                             // Capture screen
    ];

    // Enable embedded TURN server for remote access through NAT
    if (currentConfig.enableTurn) {
      args.push("-T", `turn:turn@0.0.0.0:${currentConfig.turnPort}`);
    }

    console.log(`[streaming] Command: ${STREAMER_EXE} ${args.join(" ")}`);

    streamerProcess = Bun.spawn([STREAMER_EXE, ...args], {
      cwd: BIN_DIR,
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
}
