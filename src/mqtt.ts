import mqtt, { type MqttClient } from "mqtt";
import type { TelemetryPayload, HealthPayload, EventPayload, AckPayload, LeasePayload } from "./types";

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
  // Legacy (keep)
  telemetry: (wId: string) => `watchdog/${wId}/telemetry`,
  status:    (wId: string) => `watchdog/${wId}/status`,
  commands:  (wId: string) => `watchdog/${wId}/commands`,    // OSC commands
  config:    (wId: string) => `watchdog/${wId}/config`,
  control:   (wId: string) => `watchdog/${wId}/control`,     // legacy shim

  // New ops plane
  health:    (wId: string) => `watchdog/${wId}/health`,
  event:     (wId: string) => `watchdog/${wId}/event`,
  commandSub:(wId: string) => `watchdog/${wId}/command/+`,   // subscribe wildcard
  commandTo: (wId: string, clientId: string) => `watchdog/${wId}/command/${clientId}`,
  ack:       (wId: string, clientId: string) => `watchdog/${wId}/ack/${clientId}`,
  lease:     (wId: string) => `watchdog/${wId}/lease`,
};

export type MessageHandler = (topic: string, payload: Buffer) => void;

let activeClient: MqttClient | null = null;
let activeBrokerId: string = BROKERS[0].id;
let activeWallId: string = "";
let activeMessageHandler: MessageHandler | undefined;

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

function subscribeTopics(client: MqttClient, wallId: string, onMessage?: MessageHandler) {
  // Subscribe to all inbound topics
  client.subscribe(TOPICS.control(wallId), { qos: 1 });     // legacy
  client.subscribe(TOPICS.commandSub(wallId), { qos: 1 });  // new command plane
  client.subscribe(TOPICS.lease(wallId), { qos: 1 });       // lease updates

  client.on("message", (topic, payload) => {
    if (onMessage) {
      onMessage(topic, payload);
    }
  });
}

export async function connectMqtt(
  wallId: string,
  onMessage?: MessageHandler
): Promise<MqttClient> {
  activeWallId = wallId;
  activeMessageHandler = onMessage;

  const broker = BROKERS[0]; // default to first (EMQX)
  activeBrokerId = broker.id;
  activeClient = await createClient(broker, wallId);
  subscribeTopics(activeClient, wallId, onMessage);

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

  // Disconnect old broker (no fake offline — event system handles this)
  if (activeClient) {
    try {
      activeClient.end(true);
    } catch {}
  }

  activeBrokerId = brokerId;
  activeClient = await createClient(broker, activeWallId);
  subscribeTopics(activeClient, activeWallId, activeMessageHandler);

  console.log(`[mqtt] Switched to ${broker.label}`);
  return activeClient;
}

export function getActiveClient(): MqttClient | null {
  return activeClient;
}

export function getActiveBrokerId(): string {
  return activeBrokerId;
}

// --- Publish functions ---

export function publishTelemetry(wallId: string, data: TelemetryPayload): void {
  if (!activeClient) return;
  activeClient.publish(TOPICS.telemetry(wallId), JSON.stringify(data), { qos: 0, retain: false });
}

export function publishHealth(wallId: string, data: HealthPayload): void {
  if (!activeClient) return;
  activeClient.publish(TOPICS.health(wallId), JSON.stringify(data), { qos: 1, retain: true });
}

export function publishConfig(wallId: string, data: object): void {
  if (!activeClient) return;
  activeClient.publish(TOPICS.config(wallId), JSON.stringify(data), { qos: 0, retain: true });
}

export function publishCommand(wallId: string, data: object): void {
  if (!activeClient) return;
  activeClient.publish(TOPICS.commands(wallId), JSON.stringify(data), { qos: 0, retain: false });
}

export function publishEvent(wallId: string, data: EventPayload): void {
  if (!activeClient) return;
  activeClient.publish(TOPICS.event(wallId), JSON.stringify(data), { qos: 1, retain: false });
}

export function publishAck(wallId: string, clientId: string, data: AckPayload): void {
  if (!activeClient) return;
  activeClient.publish(TOPICS.ack(wallId, clientId), JSON.stringify(data), { qos: 1, retain: false });
}

export function publishLease(wallId: string, data: LeasePayload): void {
  if (!activeClient) return;
  activeClient.publish(TOPICS.lease(wallId), JSON.stringify(data), { qos: 1, retain: true });
}
