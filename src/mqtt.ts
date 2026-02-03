import mqtt, { type MqttClient } from "mqtt";
import type { TelemetryPayload } from "./types";

export interface BrokerConfig {
  id: string;
  label: string;
  url: string;       // server-side (mqtts:// or mqtt://)
  wsUrl: string;     // dashboard (wss://)
  username: string;
  password: string;
}

// Broker presets
const BROKERS: BrokerConfig[] = [
  {
    id: "emqx",
    label: "Vu Studio (EMQX)",
    url: process.env.MQTT_BROKER_URL || "mqtts://c9b6cc55.ala.us-east-1.emqxsl.com:8883",
    wsUrl: process.env.MQTT_BROKER_WS_URL || "wss://c9b6cc55.ala.us-east-1.emqxsl.com:8084/mqtt",
    username: process.env.MQTT_USERNAME || "dev",
    password: process.env.MQTT_PASSWORD || "testing",
  },
  {
    id: "railway",
    label: "Railway",
    url: process.env.MQTT2_BROKER_URL || "mqtt://tramway.proxy.rlwy.net:20979",
    wsUrl: process.env.MQTT2_BROKER_WS_URL || "wss://mqtt.vu.studio/mqtt",
    username: process.env.MQTT2_USERNAME || "dev",
    password: process.env.MQTT2_PASSWORD || "testing",
  },
];

export function getBrokers(): BrokerConfig[] {
  return BROKERS;
}

export function getBrokerById(id: string): BrokerConfig | undefined {
  return BROKERS.find((b) => b.id === id);
}

/** Broker configs for the dashboard client (WSS URLs only) */
export function getMqttBrokerConfig() {
  return {
    brokers: BROKERS.map((b) => ({ id: b.id, label: b.label, url: b.wsUrl, username: b.username, password: b.password })),
    activeBrokerId: activeBrokerId,
  };
}

export const TOPICS = {
  telemetry: (wallId: string) => `watchdog/${wallId}/telemetry`,
  status: (wallId: string) => `watchdog/${wallId}/status`,
  commands: (wallId: string) => `watchdog/${wallId}/commands`,
  config: (wallId: string) => `watchdog/${wallId}/config`,
  control: (wallId: string) => `watchdog/${wallId}/control`,
};

export type ControlHandler = (action: string, payload: Record<string, any>) => void;

let activeClient: MqttClient | null = null;
let activeBrokerId: string = BROKERS[0].id;
let activeWallId: string = "";
let activeControlHandler: ControlHandler | undefined;

function createClient(
  broker: BrokerConfig,
  wallId: string
): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(broker.url, {
      username: broker.username || undefined,
      password: broker.password || undefined,
      clientId: `watchdog-${broker.id}-${wallId}-${Date.now()}`,
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
      reject(new Error(`MQTT connection timeout (${broker.label})`));
    }, 15_000);

    client.on("connect", () => {
      clearTimeout(timeout);
      client.publish(
        TOPICS.status(wallId),
        JSON.stringify({ status: "online", wallId, timestamp: Date.now() }),
        { qos: 1, retain: true }
      );
      console.log(`[mqtt] Connected to ${broker.label}`);
      resolve(client);
    });

    client.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function subscribeControl(client: MqttClient, wallId: string, onControl?: ControlHandler) {
  client.subscribe(TOPICS.control(wallId), { qos: 1 });
  client.on("message", (topic, payload) => {
    if (topic === TOPICS.control(wallId) && onControl) {
      try {
        const msg = JSON.parse(payload.toString());
        onControl(msg.action || "", msg);
      } catch {}
    }
  });
}

export async function connectMqtt(
  wallId: string,
  onControl?: ControlHandler
): Promise<MqttClient> {
  activeWallId = wallId;
  activeControlHandler = onControl;

  const broker = BROKERS[0]; // default to first (EMQX)
  activeBrokerId = broker.id;
  activeClient = await createClient(broker, wallId);
  subscribeControl(activeClient, wallId, onControl);

  return activeClient;
}

/** Switch the watchdog to a different broker. Returns the new client. */
export async function switchBroker(brokerId: string): Promise<MqttClient> {
  const broker = getBrokerById(brokerId);
  if (!broker) throw new Error(`Unknown broker: ${brokerId}`);
  if (brokerId === activeBrokerId && activeClient?.connected) {
    return activeClient;
  }

  console.log(`[mqtt] Switching to ${broker.label}...`);

  // Publish offline on old broker before disconnecting
  if (activeClient) {
    try {
      activeClient.publish(
        TOPICS.status(activeWallId),
        JSON.stringify({ status: "offline", wallId: activeWallId, timestamp: Date.now() }),
        { qos: 1, retain: true }
      );
      activeClient.end(true);
    } catch {}
  }

  activeBrokerId = brokerId;
  activeClient = await createClient(broker, activeWallId);
  subscribeControl(activeClient, activeWallId, activeControlHandler);

  console.log(`[mqtt] Switched to ${broker.label}`);
  return activeClient;
}

export function getActiveClient(): MqttClient | null {
  return activeClient;
}

export function getActiveBrokerId(): string {
  return activeBrokerId;
}

export function publishTelemetry(
  wallId: string,
  data: TelemetryPayload
): void {
  if (!activeClient) return;
  const json = JSON.stringify(data);
  activeClient.publish(TOPICS.telemetry(wallId), json, { qos: 0, retain: true });
}

export function publishConfig(
  wallId: string,
  data: object
): void {
  if (!activeClient) return;
  const json = JSON.stringify(data);
  activeClient.publish(TOPICS.config(wallId), json, { qos: 0, retain: true });
}

export function publishCommand(
  wallId: string,
  data: object
): void {
  if (!activeClient) return;
  const json = JSON.stringify(data);
  activeClient.publish(TOPICS.commands(wallId), json, { qos: 0, retain: false });
}
