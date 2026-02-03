import type { MqttClient, IClientPublishOptions } from "mqtt";

// --- UNS Configuration ---

interface UnsConfig {
  enabled: boolean;
  prefix: string;
  mirror: string[];
  mirrorTelemetry: boolean;
}

const config: UnsConfig = {
  enabled: (process.env.UNS_ENABLED || "false").toLowerCase() === "true",
  prefix: process.env.UNS_PREFIX || "vu/v1/asset/wall",
  mirror: ["presence", "health", "event", "command", "ack", "lease", "config"],
  mirrorTelemetry: (process.env.UNS_MIRROR_TELEMETRY || "false").toLowerCase() === "true",
};

// --- Topic mapping ---

// Maps watchdog topic suffix → UNS topic suffix
const TOPIC_MAP: Record<string, string> = {
  "status": "watchdog/presence",
  "health": "watchdog/state/reported",
  "event": "watchdog/event",
  "config": "watchdog/config",
  "lease": "watchdog/control/lease",
  "telemetry": "watchdog/telemetry/system",
};

/**
 * Mirror a publish to the UNS shadow tree.
 * Called after every MQTT publish. No-op if UNS is disabled.
 */
export function mirrorPublish(
  client: MqttClient | null,
  wallId: string,
  watchdogTopic: string,
  payload: string,
  opts: IClientPublishOptions,
): void {
  if (!config.enabled || !client) return;

  // Extract the suffix after "watchdog/{wallId}/"
  const prefix = `watchdog/${wallId}/`;
  if (!watchdogTopic.startsWith(prefix)) return;
  const suffix = watchdogTopic.slice(prefix.length);

  // Check if telemetry mirroring is enabled
  if (suffix === "telemetry" && !config.mirrorTelemetry) return;

  // Check if this suffix has a UNS mapping
  let unsSuffix: string | undefined;

  // Direct mapping
  if (TOPIC_MAP[suffix]) {
    unsSuffix = TOPIC_MAP[suffix];
  }
  // command/{clientId} → watchdog/command/{clientId}
  else if (suffix.startsWith("command/")) {
    if (!config.mirror.includes("command")) return;
    unsSuffix = `watchdog/${suffix}`;
  }
  // ack/{clientId} → watchdog/ack/{clientId}
  else if (suffix.startsWith("ack/")) {
    if (!config.mirror.includes("ack")) return;
    unsSuffix = `watchdog/${suffix}`;
  }
  // commands (OSC) — not mirrored by default
  else if (suffix === "commands") {
    return;
  }
  else {
    return; // Unknown suffix, don't mirror
  }

  // Check if this topic type is in the mirror list
  const topicType = suffix.split("/")[0]; // e.g. "status", "health", "command"
  const mirrorKey = topicType === "status" ? "presence" : topicType;
  if (!config.mirror.includes(mirrorKey) && !suffix.startsWith("command/") && !suffix.startsWith("ack/")) {
    return;
  }

  const unsTopic = `${config.prefix}/${wallId}/${unsSuffix}`;
  client.publish(unsTopic, payload, opts);
}

export function isUnsEnabled(): boolean {
  return config.enabled;
}
