/**
 * Asset management for compiled executable
 *
 * Priority order:
 * 1. Development: bin/webrtc-streamer.exe relative to cwd
 * 2. Deployed: webrtc-streamer.exe alongside executable
 * 3. Embedded: Extract from embedded base64 to temp
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Asset path - resolved at initialization
let STREAMER_EXE: string | null = null;
let initialized = false;

// Get the extraction directory for embedded binary
function getExtractDir(): string {
  return path.join(os.tmpdir(), "vu-watchdog-bin");
}

/**
 * Extract embedded streamer binary to temp directory
 */
async function extractEmbeddedStreamer(): Promise<string | null> {
  try {
    // Dynamic import to avoid bundling if not needed
    const { STREAMER_BASE64, STREAMER_SIZE } = await import("./embedded-streamer");

    const extractDir = getExtractDir();
    const extractPath = path.join(extractDir, "webrtc-streamer.exe");

    // Check if already extracted and correct size
    if (fs.existsSync(extractPath)) {
      const stats = fs.statSync(extractPath);
      if (stats.size === STREAMER_SIZE) {
        console.log("[assets] Using cached extracted streamer");
        return extractPath;
      }
    }

    console.log("[assets] Extracting embedded webrtc-streamer.exe...");

    // Create extraction directory
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    // Decode base64 and write
    const buffer = Buffer.from(STREAMER_BASE64, "base64");
    fs.writeFileSync(extractPath, buffer);

    console.log(`[assets] Extracted to ${extractPath}`);
    return extractPath;
  } catch (err) {
    // embedded-streamer.ts doesn't exist (not embedded build)
    return null;
  }
}

/**
 * Initialize asset paths
 * Call this at startup before using streaming
 */
export async function initializeAssets(): Promise<{ streamerExe: string } | null> {
  if (initialized && STREAMER_EXE) {
    return { streamerExe: STREAMER_EXE };
  }

  // Path 1: Development mode - bin/ relative to cwd
  const devStreamerExe = path.join(process.cwd(), "bin", "webrtc-streamer.exe");
  if (fs.existsSync(devStreamerExe)) {
    console.log("[assets] Using development bin/webrtc-streamer.exe");
    STREAMER_EXE = devStreamerExe;
    initialized = true;
    return { streamerExe: STREAMER_EXE };
  }

  // Path 2: Alongside executable
  const exeDir = path.dirname(process.execPath);
  const exeStreamerExe = path.join(exeDir, "webrtc-streamer.exe");
  if (fs.existsSync(exeStreamerExe)) {
    console.log("[assets] Using webrtc-streamer.exe alongside executable");
    STREAMER_EXE = exeStreamerExe;
    initialized = true;
    return { streamerExe: STREAMER_EXE };
  }

  // Path 3: Embedded binary - extract to temp
  const extractedPath = await extractEmbeddedStreamer();
  if (extractedPath) {
    STREAMER_EXE = extractedPath;
    initialized = true;
    return { streamerExe: STREAMER_EXE };
  }

  // Not found anywhere
  console.log("[assets] webrtc-streamer.exe not found (streaming disabled)");
  initialized = true;
  return null;
}

/**
 * Get the streamer executable path (sync version for compatibility)
 */
export function getStreamerExe(): string | null {
  return STREAMER_EXE;
}

/**
 * Check if streaming assets are available
 */
export function areAssetsAvailable(): boolean {
  return STREAMER_EXE !== null;
}

/**
 * Clean up extracted assets
 */
export function cleanupAssets(): void {
  const extractDir = getExtractDir();
  if (fs.existsSync(extractDir)) {
    try {
      fs.rmSync(extractDir, { recursive: true, force: true });
      console.log("[assets] Cleaned up extracted assets");
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}
