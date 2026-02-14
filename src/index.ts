import { hideConsole } from "./console";
import { startTray } from "./tray";
import { loadConfig, readConfigs, getOscPort, VUOS_DIR } from "./config";
import {
  connectMqtt, publishTelemetry, publishHealth, publishConfig,
  publishCommand, publishEvent, switchBroker, getActiveClient, TOPICS,
  clearWebrtcOffer,
} from "./mqtt";
import { startSystemPolling, collectSystem } from "./collectors/system";
import { startNetworkPolling, collectNetwork } from "./collectors/network";
import { startAppPolling, collectApp } from "./collectors/app";
import { startOscListener } from "./collectors/osc";
import {
  startServer, updateTelemetry, broadcastCommand, broadcastHealth,
  broadcastEvent, broadcastAck, setCommandProcessor, broadcastStreaming,
  broadcastRemoteStreaming,
} from "./server";
import { evaluateConditions, computeMode, buildHealth, setShuttingDown } from "./health";
import { WatchdogEventEmitter } from "./events";
import { CommandProcessor } from "./commands";
import { LeaseManager } from "./lease";
import type { TelemetryPayload, LeasePayload, CommandPayload } from "./types";
import * as path from "path";
import {
  startStreaming, stopStreaming, getStreamingState, isStreamerAvailable,
  setStreamingWallId, publishInitialStreamStatus, QUALITY_PRESETS,
  type StreamQuality,
} from "./streaming";
import { initializeAssets } from "./assets";
import {
  startRemoteViewing, stopRemoteViewing, getRemoteBridgeState,
} from "./remote-bridge";

const PUBLISH_INTERVAL_MS = 2_000;

function snapshot(wallId: string): TelemetryPayload {
  return {
    timestamp: Date.now(),
    wallId,
    system: collectSystem(),
    network: collectNetwork(),
    app: collectApp(),
  };
}

async function ensureSingleInstance() {
  try {
    await fetch("http://localhost:3200/ws", { signal: AbortSignal.timeout(1000) });
    console.error("[watchdog] Another instance is already running on port 3200");
    process.exit(1);
  } catch (e: any) {
    if (e.name === "ConnectError" || e.code === "ECONNREFUSED" || e.name === "TimeoutError") {
      return;
    }
    return;
  }
}

async function main() {
  // Prevent multiple instances
  await ensureSingleInstance();

  // Hide the console window immediately — tray menu can re-show it
  hideConsole();

  console.log("[watchdog] Starting...");

  // Initialize assets (extracts embedded webrtc-streamer if needed)
  const assets = await initializeAssets();
  if (assets) {
    console.log(`[watchdog] Streaming assets available`);
  } else {
    console.log(`[watchdog] Streaming assets not found (streaming disabled)`);
  }

  const config = loadConfig();
  const wallId = config.wallId;
  console.log(`[watchdog] Wall ID: ${wallId}, HTTP port: ${config.httpPort}`);

  // Set wallId for streaming MQTT publishing
  setStreamingWallId(wallId);

  // --- Initialize ops plane ---

  const leaseManager = new LeaseManager();

  // Event emitter: publishes to MQTT + WebSocket
  const eventEmitter = new WatchdogEventEmitter(wallId, (event) => {
    publishEvent(wallId, event);
    broadcastEvent(event);
  });

  // Command processor with handlers
  const commandProcessor = new CommandProcessor(wallId, leaseManager, eventEmitter, (ack) => {
    broadcastAck(ack);
  });

  // Register command handlers
  const vuosExe = path.resolve(VUOS_DIR, "..", "..", "..", "Vu One.exe");

  commandProcessor.registerCommand({
    type: "START_VUOS",
    requiresLease: true,
    localBypass: true,
    handler: async () => {
      console.log("[watchdog] Start Vu One OS requested");
      Bun.spawn([vuosExe], { cwd: path.dirname(vuosExe), stdio: ["ignore", "ignore", "ignore"] });
      console.log("[watchdog] Vu One OS launched");
      return { message: "Vu One OS launched", details: {} };
    },
  });

  commandProcessor.registerCommand({
    type: "RESTART_VUOS",
    requiresLease: true,
    localBypass: true,
    handler: async () => {
      console.log("[watchdog] Restart Vu One OS requested");
      Bun.spawn(["taskkill", "/F", "/IM", "Vu One.exe"], { stdio: ["ignore", "ignore", "ignore"] });
      await new Promise((r) => setTimeout(r, 2000));
      Bun.spawn([vuosExe], { cwd: path.dirname(vuosExe), stdio: ["ignore", "ignore", "ignore"] });
      console.log("[watchdog] Vu One OS relaunched");
      eventEmitter.emitLifecycle("VUOS_RESTARTED", "WARN", {});
      return { message: "Vu One OS restarted", details: {} };
    },
  });

  commandProcessor.registerCommand({
    type: "STOP_VUOS",
    requiresLease: true,
    localBypass: false,
    handler: async () => {
      console.log("[watchdog] Stop Vu One OS requested");
      Bun.spawn(["taskkill", "/F", "/IM", "Vu One.exe"], { stdio: ["ignore", "ignore", "ignore"] });
      return { message: "Vu One OS stopped", details: {} };
    },
  });

  commandProcessor.registerCommand({
    type: "QUIT_WATCHDOG",
    requiresLease: true,
    localBypass: false,
    handler: async () => {
      console.log("[watchdog] Quit requested");
      setShuttingDown(true);
      eventEmitter.emitLifecycle("WATCHDOG_SHUTTING_DOWN", "INFO", {});
      setTimeout(() => process.exit(0), 500);
      return { message: "Watchdog shutting down", details: {} };
    },
  });

  commandProcessor.registerCommand({
    type: "SWITCH_BROKER",
    requiresLease: true,
    localBypass: true,
    handler: async (args) => {
      const brokerId = args.brokerId;
      if (!brokerId) throw new Error("Missing brokerId");
      const oldBrokerId = (await import("./mqtt")).getActiveBrokerId();
      eventEmitter.emitLifecycle("BROKER_SWITCHED", "WARN", { from: oldBrokerId, to: brokerId, reason: "manual" });
      await switchBroker(brokerId);
      return { message: `Switched to broker ${brokerId}`, details: { brokerId } };
    },
  });

  commandProcessor.registerCommand({
    type: "REQUEST_TELEMETRY",
    requiresLease: false,
    localBypass: true,
    handler: async () => {
      const data = snapshot(wallId);
      publishTelemetry(wallId, data);
      updateTelemetry(data);
      return { message: "Telemetry published", details: {} };
    },
  });

  commandProcessor.registerCommand({
    type: "REQUEST_CONFIG",
    requiresLease: false,
    localBypass: true,
    handler: async () => {
      const configs = readConfigs();
      publishConfig(wallId, configs);
      return { message: "Config published", details: {} };
    },
  });

  // Helper to parse quality from args
  function parseQuality(args: Record<string, any>): StreamQuality {
    // Check for preset first
    if (args.quality && typeof args.quality === "string" && QUALITY_PRESETS[args.quality]) {
      return QUALITY_PRESETS[args.quality];
    }
    // Otherwise use explicit values or defaults
    return {
      width: args.width ?? QUALITY_PRESETS.medium.width,
      height: args.height ?? QUALITY_PRESETS.medium.height,
      fps: args.fps ?? QUALITY_PRESETS.medium.fps,
      bitrate: args.bitrate ?? QUALITY_PRESETS.medium.bitrate,
    };
  }

  // Streaming commands
  commandProcessor.registerCommand({
    type: "START_STREAM",
    requiresLease: false,
    localBypass: true,
    handler: async (args) => {
      if (!isStreamerAvailable()) {
        throw new Error("webrtc-streamer not installed");
      }
      const monitor = args.monitor !== undefined ? args.monitor : 0;
      const quality = parseQuality(args);
      await startStreaming({ monitor, quality });
      const state = getStreamingState();
      broadcastStreaming({ ...state, available: true });

      // Auto-start remote viewing
      try {
        await startRemoteViewing(wallId);
        broadcastRemoteStreaming(getRemoteBridgeState());
      } catch (e: any) {
        console.error("[streaming] Failed to auto-start remote viewing:", e.message);
      }

      return {
        message: "Streaming started",
        details: { state, remote: getRemoteBridgeState() },
      };
    },
  });

  commandProcessor.registerCommand({
    type: "STOP_STREAM",
    requiresLease: false,
    localBypass: true,
    handler: async () => {
      // Stop remote viewing first
      await stopRemoteViewing();
      broadcastRemoteStreaming(getRemoteBridgeState());

      // Stop local streaming
      await stopStreaming();
      const state = getStreamingState();
      broadcastStreaming({ ...state, available: isStreamerAvailable() });

      return { message: "Streaming stopped", details: { state } };
    },
  });

  commandProcessor.registerCommand({
    type: "SET_STREAM_QUALITY",
    requiresLease: false,
    localBypass: true,
    handler: async (args) => {
      const currentState = getStreamingState();
      if (currentState.status !== "running") {
        throw new Error("Stream is not running");
      }

      // Get current monitor setting and new quality
      const quality = parseQuality(args);
      const monitor = args.monitor !== undefined ? args.monitor : 0;

      // Stop current stream
      await stopRemoteViewing();
      await stopStreaming();

      // Restart with new quality
      await startStreaming({ monitor, quality });
      const state = getStreamingState();
      broadcastStreaming({ ...state, available: true });

      // Restart remote viewing
      try {
        await startRemoteViewing(wallId);
        broadcastRemoteStreaming(getRemoteBridgeState());
      } catch (e: any) {
        console.error("[streaming] Failed to restart remote viewing:", e.message);
      }

      return {
        message: "Stream quality updated",
        details: { state, quality, remote: getRemoteBridgeState() },
      };
    },
  });

  // Wire command processor to server
  setCommandProcessor(commandProcessor);

  // Start background polling for slow collectors
  startSystemPolling();
  startNetworkPolling(config.httpPort);
  startAppPolling();

  // Emit lifecycle event (before MQTT — will be buffered)
  eventEmitter.emitLifecycle("WATCHDOG_STARTED", "INFO", { wallId });

  // Wait a moment for initial polls to populate caches
  await new Promise((r) => setTimeout(r, 3000));

  // --- Connect MQTT with unified message handler ---
  console.log("[watchdog] Connecting to MQTT broker...");

  await connectMqtt(wallId, (topic, payload) => {
    try {
      const msg = JSON.parse(payload.toString());

      // New command plane: watchdog/{wallId}/command/{clientId}
      const commandPrefix = `watchdog/${wallId}/command/`;
      if (topic.startsWith(commandPrefix)) {
        const clientId = topic.slice(commandPrefix.length);
        commandProcessor.handle(msg as CommandPayload, clientId, false);
        return;
      }

      // Lease updates: watchdog/{wallId}/lease
      if (topic === TOPICS.lease(wallId)) {
        leaseManager.update(msg as LeasePayload);
        return;
      }

      // Legacy control: watchdog/{wallId}/control
      if (topic === TOPICS.control(wallId)) {
        commandProcessor.handleLegacy(msg);
        return;
      }
    } catch {}
  });

  console.log("[watchdog] MQTT connected");
  eventEmitter.emitLifecycle("BROKER_CONNECTED", "INFO", {});

  // Clear stale retained messages and publish initial stopped status
  clearWebrtcOffer(wallId);
  publishInitialStreamStatus();

  const client = getActiveClient();
  if (client) {
    client.on("error", (err) => {
      console.error("[watchdog] MQTT error:", err.message);
    });
    client.on("reconnect", () => {
      console.log("[watchdog] MQTT reconnecting...");
    });
  }

  // Start local dashboard server
  startServer(wallId);

  // Launch system tray icon
  startTray(wallId);

  // Start OSC listener — forwards commands to MQTT + local dashboard
  const oscPort = getOscPort();
  startOscListener((command) => {
    broadcastCommand(command);
    publishCommand(wallId, command);
  }, oscPort);

  // Publish config (retained) — refresh every 60s
  function pubConfig() {
    const configs = readConfigs();
    publishConfig(wallId, configs);
  }
  pubConfig();
  setInterval(pubConfig, 60_000);
  console.log("[watchdog] Published config");

  // Initial publish
  const data = snapshot(wallId);
  publishTelemetry(wallId, data);
  console.log("[watchdog] Published initial telemetry");
  console.log(JSON.stringify(data, null, 2));

  // --- Main 2s loop ---
  let previousMode = computeMode(evaluateConditions(data));

  setInterval(() => {
    try {
      const telemetry = snapshot(wallId);

      // Evaluate conditions and compute mode
      const conditions = evaluateConditions(telemetry);
      const mode = computeMode(conditions);

      // Edge-trigger events from condition changes
      eventEmitter.updateConditions(conditions);
      eventEmitter.updateMode(mode);

      // Build health summary
      const health = buildHealth(wallId, telemetry, mode, conditions);

      // Log mode transitions
      if (mode !== previousMode) {
        console.log(`[health] Mode: ${previousMode} → ${mode}`);
        previousMode = mode;
      }

      // Publish
      publishTelemetry(wallId, telemetry);   // NOT retained
      publishHealth(wallId, health);          // retained
      updateTelemetry(telemetry);             // WebSocket
      broadcastHealth(health);                // WebSocket
    } catch (err: any) {
      console.error("[watchdog] Error publishing:", err.message);
    }
  }, PUBLISH_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[watchdog] Fatal error:", err);
  process.exit(1);
});
