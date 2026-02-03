import mqtt, { type MqttClient } from "mqtt";
import type { TelemetryPayload } from "./types";

// Primary broker (EMQX — always connected, MQTTS for Bun compatibility)
const BROKER_URL = process.env.MQTT_BROKER_URL || "mqtts://c9b6cc55.ala.us-east-1.emqxsl.com:8883";
const USERNAME = process.env.MQTT_USERNAME || "dev";
const PASSWORD = process.env.MQTT_PASSWORD || "testing";

// Secondary broker (optional — telemetry mirror)
const BROKER2_URL = process.env.MQTT2_BROKER_URL || "";
const USERNAME2 = process.env.MQTT2_USERNAME || "";
const PASSWORD2 = process.env.MQTT2_PASSWORD || "";

/** Broker configs for the dashboard client */
export function getMqttBrokerConfig() {
  const primary = {
    label: "Vu Studio (EMQX)",
    url: process.env.MQTT_BROKER_WS_URL || "wss://c9b6cc55.ala.us-east-1.emqxsl.com:8084/mqtt",
    username: USERNAME,
    password: PASSWORD,
  };
  const secondary = BROKER2_URL
    ? {
        label: process.env.MQTT2_LABEL || "Secondary Broker",
        url: process.env.MQTT2_BROKER_WS_URL || BROKER2_URL,
        username: USERNAME2,
        password: PASSWORD2,
      }
    : null;
  return { primary, secondary };
}

export const TOPICS = {
  telemetry: (wallId: string) => `watchdog/${wallId}/telemetry`,
  status: (wallId: string) => `watchdog/${wallId}/status`,
  commands: (wallId: string) => `watchdog/${wallId}/commands`,
  config: (wallId: string) => `watchdog/${wallId}/config`,
  control: (wallId: string) => `watchdog/${wallId}/control`,
};

export type ControlHandler = (action: string, payload: Record<string, any>) => void;

function createClient(
  url: string,
  username: string,
  password: string,
  wallId: string,
  label: string
): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, {
      username: username || undefined,
      password: password || undefined,
      clientId: `watchdog-${label}-${wallId}-${Date.now()}`,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      will: {
        topic: TOPICS.status(wallId),
        payload: Buffer.from(
          JSON.stringify({ status: "offline", wallId, timestamp: Date.now() })
        ),
        qos: 1,
        retain: true,
      },
    });

    const timeout = setTimeout(() => {
      reject(new Error(`MQTT connection timeout (${label})`));
    }, 15_000);

    client.on("connect", () => {
      clearTimeout(timeout);
      client.publish(
        TOPICS.status(wallId),
        JSON.stringify({ status: "online", wallId, timestamp: Date.now() }),
        { qos: 1, retain: true }
      );
      console.log(`[mqtt] Connected to ${label}`);
      resolve(client);
    });

    client.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export async function connectMqtt(
  wallId: string,
  onControl?: ControlHandler
): Promise<{ primary: MqttClient; secondary: MqttClient | null }> {
  // Primary — always connects
  const primary = await createClient(BROKER_URL, USERNAME, PASSWORD, wallId, "primary");

  // Subscribe to control topic on primary
  primary.subscribe(TOPICS.control(wallId), { qos: 1 });
  primary.on("message", (topic, payload) => {
    if (topic === TOPICS.control(wallId) && onControl) {
      try {
        const msg = JSON.parse(payload.toString());
        onControl(msg.action || "", msg);
      } catch {}
    }
  });

  // Secondary — optional
  let secondary: MqttClient | null = null;
  if (BROKER2_URL) {
    try {
      secondary = await createClient(BROKER2_URL, USERNAME2, PASSWORD2, wallId, "secondary");
    } catch (err: any) {
      console.error(`[mqtt] Secondary broker failed: ${err.message}`);
    }
  }

  return { primary, secondary };
}

export function publishTelemetry(
  clients: { primary: MqttClient; secondary: MqttClient | null },
  wallId: string,
  data: TelemetryPayload
): void {
  const json = JSON.stringify(data);
  const opts = { qos: 0 as const, retain: true };
  clients.primary.publish(TOPICS.telemetry(wallId), json, opts);
  clients.secondary?.publish(TOPICS.telemetry(wallId), json, opts);
}

export function publishConfig(
  clients: { primary: MqttClient; secondary: MqttClient | null },
  wallId: string,
  data: object
): void {
  const json = JSON.stringify(data);
  const opts = { qos: 0 as const, retain: true };
  clients.primary.publish(TOPICS.config(wallId), json, opts);
  clients.secondary?.publish(TOPICS.config(wallId), json, opts);
}

export function publishCommand(
  clients: { primary: MqttClient; secondary: MqttClient | null },
  wallId: string,
  data: object
): void {
  const json = JSON.stringify(data);
  const opts = { qos: 0 as const, retain: false };
  clients.primary.publish(TOPICS.commands(wallId), json, opts);
  clients.secondary?.publish(TOPICS.commands(wallId), json, opts);
}
