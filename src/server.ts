import html from "../index.html" with { type: "text" };
import type { TelemetryPayload, HealthPayload, EventPayload, AckPayload } from "./types";
import { readConfigs, VUOS_DIR } from "./config";
import { getMqttBrokerConfig, getActiveBrokerId } from "./mqtt";
import type { ServerWebSocket } from "bun";
import type { CommandProcessor } from "./commands";
import {
  startStreaming, stopStreaming, getStreamingState, getViewerUrl,
  isStreamerAvailable, type StreamingState
} from "./streaming";
import {
  startRemoteBridge, stopRemoteBridge, getBridgeState,
  setStateChangeCallback, type VdoBridgeState
} from "./vdo-bridge";

const PORT = 3200;

type WsData = { id: number };

const wsClients = new Set<ServerWebSocket<WsData>>();
let nextId = 0;

let latestTelemetry: TelemetryPayload | null = null;
let latestHealth: HealthPayload | null = null;
let commandProcessor: CommandProcessor | null = null;

export function setCommandProcessor(cp: CommandProcessor) {
  commandProcessor = cp;
}

export function updateTelemetry(data: TelemetryPayload) {
  latestTelemetry = data;
  broadcast({ type: "telemetry", data });
}

export function broadcastHealth(data: HealthPayload) {
  latestHealth = data;
  broadcast({ type: "health", data });
}

export function broadcastEvent(event: EventPayload) {
  broadcast({ type: "event", data: event });
}

export function broadcastAck(ack: AckPayload) {
  broadcast({ type: "ack", data: ack });
}

export function broadcastCommand(command: {
  timestamp: number;
  address: string;
  args: (string | number | boolean)[];
}) {
  broadcast({ type: "command", data: command });
}

export function broadcastStreaming(state: StreamingState & { available: boolean }) {
  broadcast({ type: "streaming", data: state });
}

export function broadcastRemoteStreaming(state: VdoBridgeState) {
  broadcast({ type: "remoteStreaming", data: state });
}

function broadcast(msg: object) {
  const json = JSON.stringify(msg);
  for (const ws of wsClients) {
    try {
      ws.send(json);
    } catch {}
  }
}

function getConfigPayload() {
  const configs = readConfigs();
  return { ...configs, mqttBroker: getMqttBrokerConfig() };
}

function sendConfig(ws: ServerWebSocket<WsData>) {
  ws.send(JSON.stringify({ type: "config", data: getConfigPayload() }));
}

export function startServer(wallId: string) {
  // Set up VDO bridge state change callback
  setStateChangeCallback((state) => {
    broadcast({ type: "remoteStreaming", data: state });
  });

  // Broadcast config to all clients every 60s
  setInterval(() => {
    broadcast({ type: "config", data: getConfigPayload() });
  }, 60_000);

  Bun.serve<WsData>({
    port: PORT,
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, { data: { id: nextId++ } });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }

      // --- All action endpoints route through command processor ---

      // Start Vu One OS
      if (url.pathname === "/api/start-vuos" && req.method === "POST") {
        if (!commandProcessor) {
          return jsonResponse({ ok: false, error: "Not ready" }, 503);
        }
        const ack = await commandProcessor.handleLocal("START_VUOS");
        return jsonResponse({ ok: ack.status === "APPLIED", ack });
      }

      // Restart Vu One OS
      if (url.pathname === "/api/restart-vuos" && req.method === "POST") {
        if (!commandProcessor) {
          return jsonResponse({ ok: false, error: "Not ready" }, 503);
        }
        const ack = await commandProcessor.handleLocal("RESTART_VUOS");
        return jsonResponse({ ok: ack.status === "APPLIED", ack });
      }

      // Switch MQTT broker
      if (url.pathname === "/api/switch-broker" && req.method === "POST") {
        if (!commandProcessor) {
          return jsonResponse({ ok: false, error: "Not ready" }, 503);
        }
        try {
          const body = await req.json();
          const brokerId = body.brokerId;
          if (!brokerId) {
            return jsonResponse({ ok: false, error: "Missing brokerId" }, 400);
          }
          const ack = await commandProcessor.handleLocal("SWITCH_BROKER", { brokerId });
          return jsonResponse({ ok: ack.status === "APPLIED", ack, activeBrokerId: getActiveBrokerId() });
        } catch (e: any) {
          return jsonResponse({ ok: false, error: e.message }, 500);
        }
      }

      // Quit watchdog
      if (url.pathname === "/api/quit" && req.method === "POST") {
        if (!commandProcessor) {
          return jsonResponse({ ok: false, error: "Not ready" }, 503);
        }
        const ack = await commandProcessor.handleLocal("QUIT_WATCHDOG");
        return jsonResponse({ ok: ack.status === "APPLIED", ack });
      }

      // --- Screen Streaming Endpoints ---

      // Start streaming
      if (url.pathname === "/api/stream-start" && req.method === "POST") {
        try {
          if (!isStreamerAvailable()) {
            return jsonResponse({
              ok: false,
              error: "webrtc-streamer not installed. Run: bun scripts/download-webrtc-streamer.ts"
            }, 400);
          }
          await startStreaming();
          const state = getStreamingState();
          broadcast({ type: "streaming", data: state });
          return jsonResponse({ ok: true, state });
        } catch (e: any) {
          return jsonResponse({ ok: false, error: e.message }, 500);
        }
      }

      // Stop streaming
      if (url.pathname === "/api/stream-stop" && req.method === "POST") {
        try {
          await stopStreaming();
          const state = getStreamingState();
          broadcast({ type: "streaming", data: state });
          return jsonResponse({ ok: true, state });
        } catch (e: any) {
          return jsonResponse({ ok: false, error: e.message }, 500);
        }
      }

      // Get streaming status
      if (url.pathname === "/api/stream-status" && req.method === "GET") {
        const state = getStreamingState();
        const host = req.headers.get("host") || `localhost:${PORT}`;
        return jsonResponse({
          ...state,
          available: isStreamerAvailable(),
          viewerUrl: state.status === "running" ? getViewerUrl(host.split(":")[0] + ":8000") : null,
        });
      }

      // --- Remote Streaming (VDO.ninja Bridge) Endpoints ---

      // Start remote streaming
      if (url.pathname === "/api/remote-stream-start" && req.method === "POST") {
        try {
          // Ensure local streaming is running first
          const streamState = getStreamingState();
          if (streamState.status !== "running") {
            return jsonResponse({
              ok: false,
              error: "Local streaming must be running first. Start it via /api/stream-start"
            }, 400);
          }

          const viewerUrl = await startRemoteBridge(wallId);
          const bridgeState = getBridgeState();
          broadcast({ type: "remoteStreaming", data: bridgeState });
          return jsonResponse({ ok: true, ...bridgeState });
        } catch (e: any) {
          return jsonResponse({ ok: false, error: e.message }, 500);
        }
      }

      // Stop remote streaming
      if (url.pathname === "/api/remote-stream-stop" && req.method === "POST") {
        try {
          await stopRemoteBridge();
          const bridgeState = getBridgeState();
          broadcast({ type: "remoteStreaming", data: bridgeState });
          return jsonResponse({ ok: true, ...bridgeState });
        } catch (e: any) {
          return jsonResponse({ ok: false, error: e.message }, 500);
        }
      }

      // Get remote streaming status
      if (url.pathname === "/api/remote-stream-status" && req.method === "GET") {
        return jsonResponse(getBridgeState());
      }

      // Serve index.html
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws) {
        wsClients.add(ws);
        sendConfig(ws);
        if (latestTelemetry) {
          ws.send(JSON.stringify({ type: "telemetry", data: latestTelemetry }));
        }
        if (latestHealth) {
          ws.send(JSON.stringify({ type: "health", data: latestHealth }));
        }
        // Send streaming state
        ws.send(JSON.stringify({
          type: "streaming",
          data: { ...getStreamingState(), available: isStreamerAvailable() }
        }));
        // Send remote streaming state
        ws.send(JSON.stringify({
          type: "remoteStreaming",
          data: getBridgeState()
        }));
      },
      message(_ws, msg) {
        // Handle inbound commands from local dashboard
        if (!commandProcessor) return;
        try {
          const parsed = JSON.parse(String(msg));
          if (parsed.type === "command" && parsed.data) {
            commandProcessor.handleLocal(parsed.data.type, parsed.data.args || {});
          }
        } catch {}
      },
      close(ws) {
        wsClients.delete(ws);
      },
    },
  });

  console.log(`[watchdog] Dashboard: http://localhost:${PORT}`);
}

function jsonResponse(data: object, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
