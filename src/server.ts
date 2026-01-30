import html from "../index.html" with { type: "text" };
import type { TelemetryPayload } from "./types";
import { readConfigs } from "./config";
import { getMqttBrokerConfig } from "./mqtt";
import type { ServerWebSocket } from "bun";

const PORT = 3200;

type WsData = { id: number };

const wsClients = new Set<ServerWebSocket<WsData>>();
let nextId = 0;

let latestTelemetry: TelemetryPayload | null = null;

export function updateTelemetry(data: TelemetryPayload) {
  latestTelemetry = data;
  broadcast({ type: "telemetry", data });
}

export function broadcastCommand(command: {
  timestamp: number;
  address: string;
  args: (string | number | boolean)[];
}) {
  broadcast({ type: "command", data: command });
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
  // Broadcast config to all clients every 60s
  setInterval(() => {
    broadcast({ type: "config", data: getConfigPayload() });
  }, 60_000);

  Bun.serve<WsData>({
    port: PORT,
    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, { data: { id: nextId++ } });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }

      // Quit watchdog
      if (url.pathname === "/api/quit" && req.method === "POST") {
        console.log("[watchdog] Quit requested from dashboard");
        setTimeout(() => process.exit(0), 500);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
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
      },
      message(_ws, _msg) {
        // No inbound messages expected
      },
      close(ws) {
        wsClients.delete(ws);
      },
    },
  });

  console.log(`[watchdog] Dashboard: http://localhost:${PORT}`);
}
