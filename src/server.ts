import html from "../index.html" with { type: "text" };
import type { TelemetryPayload } from "./types";
import { readConfigs } from "./config";
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

function sendConfig(ws: ServerWebSocket<WsData>) {
  const configs = readConfigs();
  ws.send(JSON.stringify({ type: "config", data: configs }));
}

export function startServer(wallId: string) {
  // Broadcast config to all clients every 60s
  setInterval(() => {
    const configs = readConfigs();
    broadcast({ type: "config", data: configs });
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

  const url = `http://localhost:${PORT}`;
  console.log(`[watchdog] Dashboard: ${url}`);

  // Open in default browser
  const cmd = process.platform === "win32" ? ["cmd", "/c", "start", url]
    : process.platform === "darwin" ? ["open", url]
    : ["xdg-open", url];
  Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] });
}
