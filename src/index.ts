import { hideConsole } from "./console";
import { startTray } from "./tray";
import { loadConfig, readConfigs, getOscPort, VUOS_DIR } from "./config";
import { connectMqtt, publishTelemetry, publishConfig, publishCommand, TOPICS } from "./mqtt";
import { startSystemPolling, collectSystem } from "./collectors/system";
import { startNetworkPolling, collectNetwork } from "./collectors/network";
import { startAppPolling, collectApp } from "./collectors/app";
import { startOscListener } from "./collectors/osc";
import { startServer, updateTelemetry, broadcastCommand } from "./server";
import type { TelemetryPayload } from "./types";
import * as path from "path";

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

function handleRestart() {
  console.log("[watchdog] Restart Vu One OS requested via MQTT control");
  Bun.spawn(["taskkill", "/F", "/IM", "Vu One.exe"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const vuosExe = path.resolve(VUOS_DIR, "..", "..", "..", "Vu One.exe");
  setTimeout(() => {
    try {
      Bun.spawn([vuosExe], {
        cwd: path.dirname(vuosExe),
        stdio: ["ignore", "ignore", "ignore"],
      });
      console.log("[watchdog] Vu One OS relaunched");
    } catch (e: any) {
      console.error("[watchdog] Failed to launch Vu One:", e.message);
    }
  }, 2000);
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

  const config = loadConfig();
  console.log(`[watchdog] Wall ID: ${config.wallId}, HTTP port: ${config.httpPort}`);

  // Start background polling for slow collectors
  startSystemPolling();
  startNetworkPolling(config.httpPort);
  startAppPolling();

  // Wait a moment for initial polls to populate caches
  await new Promise((r) => setTimeout(r, 3000));

  console.log("[watchdog] Connecting to MQTT broker...");
  const clients = await connectMqtt(config.wallId, (action) => {
    switch (action) {
      case "restart-vuos":
        handleRestart();
        break;
      case "quit":
        console.log("[watchdog] Quit requested via MQTT control");
        process.exit(0);
        break;
      default:
        console.log(`[watchdog] Unknown control action: ${action}`);
    }
  });
  console.log("[watchdog] MQTT connected");

  clients.primary.on("error", (err) => {
    console.error("[watchdog] MQTT primary error:", err.message);
  });

  clients.primary.on("reconnect", () => {
    console.log("[watchdog] MQTT primary reconnecting...");
  });

  // Start local dashboard server
  startServer(config.wallId);

  // Launch system tray icon
  startTray(config.wallId);

  // Start OSC listener — forwards commands to MQTT + local dashboard
  const oscPort = getOscPort();
  startOscListener((command) => {
    broadcastCommand(command);
    publishCommand(clients, config.wallId, command);
  }, oscPort);

  // Publish config (retained) — refresh every 60s
  function pubConfig() {
    const configs = readConfigs();
    publishConfig(clients, config.wallId, configs);
  }
  pubConfig();
  setInterval(pubConfig, 60_000);
  console.log("[watchdog] Published config");

  // Initial publish
  const data = snapshot(config.wallId);
  publishTelemetry(clients, config.wallId, data);
  console.log("[watchdog] Published initial telemetry");
  console.log(JSON.stringify(data, null, 2));

  // Realtime publish loop — every 2s
  setInterval(() => {
    try {
      const data = snapshot(config.wallId);
      publishTelemetry(clients, config.wallId, data);
      updateTelemetry(data);
    } catch (err: any) {
      console.error("[watchdog] Error publishing:", err.message);
    }
  }, PUBLISH_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[watchdog] Fatal error:", err);
  process.exit(1);
});
