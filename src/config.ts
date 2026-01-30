import * as fs from "fs";
import * as path from "path";

export interface AppConfig {
  wallId: string;
  websocketPort: number;
  httpPort: number;
}

const VUOS_CANDIDATES = [
  "C:\\Program Files (x86)\\Vu One\\Vu One_Data\\StreamingAssets\\Vu One",
  "C:\\Program Files (x86)\\Vu One OS\\Vu One_Data\\StreamingAssets\\Vu One",
];

function detectVuosDir(): string {
  for (const dir of VUOS_CANDIDATES) {
    if (fs.existsSync(path.join(dir, "app.config.json"))) return dir;
  }
  throw new Error(
    `Vu One OS not found. Checked:\n${VUOS_CANDIDATES.join("\n")}`
  );
}

export const VUOS_DIR = detectVuosDir();
const APP_CONFIG_PATH = path.join(VUOS_DIR, "app.config.json");
const SYSTEM_CONFIG_PATH = path.join(VUOS_DIR, "system.config.json");

export function loadConfig(): AppConfig {
  const raw = fs.readFileSync(APP_CONFIG_PATH, "utf-8");
  const parsed = JSON.parse(raw);

  if (!parsed.wallId || !parsed.httpPort) {
    throw new Error(
      `Invalid app.config.json: missing wallId or httpPort at ${APP_CONFIG_PATH}`
    );
  }

  return {
    wallId: parsed.wallId,
    websocketPort: parsed.websocketPort,
    httpPort: parsed.httpPort,
  };
}

/** Read both config files and return combined raw data */
export function readConfigs(): Record<string, any> {
  let appConfig: any = {};
  let systemConfig: any = {};

  try {
    appConfig = JSON.parse(fs.readFileSync(APP_CONFIG_PATH, "utf-8"));
  } catch {}

  try {
    systemConfig = JSON.parse(fs.readFileSync(SYSTEM_CONFIG_PATH, "utf-8"));
    // Slim down displayedAssets — keep essential fields + image URLs, drop thumbnails
    if (systemConfig.displays) {
      systemConfig.displays = systemConfig.displays.map((d: any) => ({
        ...d,
        displayedAssets: (d.displayedAssets || []).map((a: any) => ({
          id: a.id,
          title: a.title,
          type: a.type,
          filenameDownload: a.filenameDownload,
          src: a.src,
          downloadLink: a.downloadLink,
          savedMediaControls: a.savedMediaControls,
        })),
      }));
    }
  } catch {}

  return { appConfig, systemConfig };
}
