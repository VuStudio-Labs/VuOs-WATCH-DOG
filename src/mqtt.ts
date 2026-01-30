import mqtt, { type MqttClient } from "mqtt";
import type { TelemetryPayload } from "./types";

const BROKER_URL = "mqtt://tramway.proxy.rlwy.net:20979";
const USERNAME = "dev";
const PASSWORD = "testing";

export const TOPICS = {
  telemetry: (wallId: string) => `vu/${wallId}/telemetry`,
  health: (wallId: string) => `vu/${wallId}/telemetry/health`,
  commands: (wallId: string) => `vu/${wallId}/commands`,
  config: (wallId: string) => `vu/${wallId}/config`,
};

export function connectMqtt(wallId: string): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(BROKER_URL, {
      username: USERNAME,
      password: PASSWORD,
      clientId: `watchdog-${wallId}-${Date.now()}`,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      will: {
        topic: TOPICS.health(wallId),
        payload: Buffer.from(
          JSON.stringify({ status: "offline", wallId, timestamp: Date.now() })
        ),
        qos: 1,
        retain: true,
      },
    });

    const timeout = setTimeout(() => {
      reject(new Error("MQTT connection timeout"));
    }, 15_000);

    client.on("connect", () => {
      clearTimeout(timeout);
      // Publish online status
      client.publish(
        TOPICS.health(wallId),
        JSON.stringify({ status: "online", wallId, timestamp: Date.now() }),
        { qos: 1, retain: true }
      );
      resolve(client);
    });

    client.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export function publishTelemetry(
  client: MqttClient,
  wallId: string,
  data: TelemetryPayload
): void {
  client.publish(TOPICS.telemetry(wallId), JSON.stringify(data), {
    qos: 0,
    retain: true,
  });
}
