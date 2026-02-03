import type { NetworkMetrics } from "../types";
import { loadConfig } from "../config";

// --- Cached slow metrics ---
let cachedOnline = false;
let cachedLatencyMs: number | null = null;
let cachedReachable = false;
let cachedPeers = 0;
let currentHttpPort: number = 0;

async function checkInternet() {
  try {
    const start = performance.now();
    const res = await fetch("https://www.google.com/generate_204", {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    cachedLatencyMs = Math.round(performance.now() - start);
    cachedOnline = res.ok || res.status === 204;
  } catch {
    cachedOnline = false;
    cachedLatencyMs = null;
  }
}

function refreshHttpPort() {
  try {
    const config = loadConfig();
    if (config.httpPort !== currentHttpPort) {
      console.log(`[network] HTTP port changed: ${currentHttpPort} → ${config.httpPort}`);
      currentHttpPort = config.httpPort;
    }
  } catch {}
}

async function checkLocalServer() {
  if (!currentHttpPort) return;
  try {
    const res = await fetch(`http://localhost:${currentHttpPort}/connected-users`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      cachedReachable = false;
      cachedPeers = 0;
      return;
    }
    const data = await res.json();
    cachedReachable = true;
    cachedPeers = Array.isArray(data) ? data.length : 0;
  } catch {
    cachedReachable = false;
    cachedPeers = 0;
  }
}

/** Start background polling for network checks */
export function startNetworkPolling(httpPort: number) {
  currentHttpPort = httpPort;

  // Internet: every 10s
  checkInternet();
  setInterval(checkInternet, 10_000);

  // Re-read httpPort from config every 10s (Vu OS may regenerate ports on restart)
  setInterval(refreshHttpPort, 10_000);

  // Local server: every 3s
  checkLocalServer();
  setInterval(checkLocalServer, 3_000);
}

/** Fast snapshot from cache */
export function collectNetwork(): NetworkMetrics {
  return {
    internetOnline: cachedOnline,
    latencyMs: cachedLatencyMs,
    localServerReachable: cachedReachable,
    connectedPeers: cachedPeers,
  };
}
