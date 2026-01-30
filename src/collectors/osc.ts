import * as dgram from "dgram";
import type { MqttClient } from "mqtt";
import { TOPICS } from "../mqtt";

const OSC_PORT = 1231;

interface OscMessage {
  address: string;
  args: (string | number | boolean)[];
}

function parseOsc(msg: Buffer): OscMessage | null {
  try {
    // Address: null-terminated string, padded to 4-byte boundary
    const nullIdx = msg.indexOf(0);
    if (nullIdx < 0) return null;
    const address = msg.toString("utf-8", 0, nullIdx);

    let i = Math.ceil((nullIdx + 1) / 4) * 4;

    // Type tag string starts with ','
    if (i >= msg.length || msg[i] !== 0x2c) return { address, args: [] };
    const typeEnd = msg.indexOf(0, i);
    const types = msg.toString("utf-8", i + 1, typeEnd);
    i = Math.ceil((typeEnd + 1) / 4) * 4;

    const args: (string | number | boolean)[] = [];
    for (const t of types) {
      if (t === "i") {
        args.push(msg.readInt32BE(i));
        i += 4;
      } else if (t === "f") {
        args.push(Math.round(msg.readFloatBE(i) * 1000) / 1000);
        i += 4;
      } else if (t === "s") {
        const end = msg.indexOf(0, i);
        args.push(msg.toString("utf-8", i, end));
        i = Math.ceil((end + 1) / 4) * 4;
      } else if (t === "T") {
        args.push(true);
      } else if (t === "F") {
        args.push(false);
      }
    }
    return { address, args };
  } catch {
    return null;
  }
}

export type OscCommandCallback = (command: {
  timestamp: number;
  address: string;
  args: (string | number | boolean)[];
}) => void;

export function startOscListener(
  wallId: string,
  mqttClient: MqttClient,
  onCommand?: OscCommandCallback
) {
  const sock = dgram.createSocket("udp4");
  const topic = TOPICS.commands(wallId);

  sock.on("message", (msg) => {
    const parsed = parseOsc(msg);
    if (!parsed || parsed.address === "/VuOne/ping") return;

    // Skip userData — massive JSON blob with sensitive profile data
    if (parsed.address === "/VuOne/userData") return;

    const command = {
      timestamp: Date.now(),
      address: parsed.address,
      args: parsed.args,
    };

    mqttClient.publish(topic, JSON.stringify(command), { qos: 0, retain: false });
    onCommand?.(command);
  });

  sock.on("error", (err) => {
    console.error("[osc] error:", err.message);
  });

  sock.bind(OSC_PORT, "0.0.0.0", () => {
    console.log(`[osc] listening on :${OSC_PORT}`);
  });

  return sock;
}
