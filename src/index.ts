import { hideConsole } from "./console";
import { startTray } from "./tray";
import { loadConfig, readConfigs } from "./config";
import { connectMqtt, publishTelemetry, TOPICS } from "./mqtt";
import { startSystemPolling, collectSystem } from "./collectors/system";
import { startNetworkPolling, collectNetwork } from "./collectors/network";
import { startAppPolling, collectApp } from "./collectors/app";
import { startOscListener } from "./collectors/osc";
import { startServer, updateTelemetry, broadcastCommand } from "./server";
import type { TelemetryPayload } from "./types";

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

async function main() {
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
  const client = await connectMqtt(config.wallId);
  console.log("[watchdog] MQTT connected");

  client.on("error", (err) => {
    console.error("[watchdog] MQTT error:", err.message);
  });

  client.on("reconnect", () => {
    console.log("[watchdog] MQTT reconnecting...");
  });

  // Start local dashboard server
  startServer(config.wallId);

  // Launch system tray icon
  startTray(config.wallId);

  // Start OSC listener — forwards commands to MQTT + local dashboard
  startOscListener(config.wallId, client, broadcastCommand);

  // Publish config (retained) — refresh every 60s
  function publishConfig() {
    const configs = readConfigs();
    client.publish(
      TOPICS.config(config.wallId),
      JSON.stringify(configs),
      { qos: 0, retain: true }
    );
  }
  publishConfig();
  setInterval(publishConfig, 60_000);
  console.log("[watchdog] Published config");

  // Initial publish
  const data = snapshot(config.wallId);
  publishTelemetry(client, config.wallId, data);
  console.log("[watchdog] Published initial telemetry");
  console.log(JSON.stringify(data, null, 2));

  // Realtime publish loop — every 2s
  setInterval(() => {
    try {
      const data = snapshot(config.wallId);
      publishTelemetry(client, config.wallId, data);
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
