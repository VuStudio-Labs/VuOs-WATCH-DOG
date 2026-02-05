/**
 * Embedded asset management for compiled executable
 *
 * In development: Uses bin/ directory relative to cwd
 * In production (compiled exe): Looks alongside executable or in temp
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Asset path - resolved at initialization
let STREAMER_EXE: string | null = null;
let initialized = false;

// Get the extraction directory for embedded assets
function getExtractDir(): string {
  return path.join(os.tmpdir(), "vu-watchdog-bin");
}

/**
 * Initialize asset paths
 * Call this at startup before using streaming
 */
export function initializeAssets(): { streamerExe: string } | null {
  if (initialized && STREAMER_EXE) {
    return { streamerExe: STREAMER_EXE };
  }

  // Path 1: Development mode - bin/ relative to cwd
  const devBinDir = path.join(process.cwd(), "bin");
  const devStreamerExe = path.join(devBinDir, "webrtc-streamer.exe");

  if (fs.existsSync(devStreamerExe)) {
    console.log("[assets] Using development bin/ directory");
    STREAMER_EXE = devStreamerExe;
    initialized = true;
    return { streamerExe: STREAMER_EXE };
  }

  // Path 2: Compiled exe - check alongside executable
  const exeDir = path.dirname(process.execPath);
  const exeStreamerExe = path.join(exeDir, "webrtc-streamer.exe");

  if (fs.existsSync(exeStreamerExe)) {
    console.log("[assets] Using webrtc-streamer alongside executable");
    STREAMER_EXE = exeStreamerExe;
    initialized = true;
    return { streamerExe: STREAMER_EXE };
  }

  // Path 3: Check in bin/ subfolder alongside executable
  const exeBinStreamerExe = path.join(exeDir, "bin", "webrtc-streamer.exe");

  if (fs.existsSync(exeBinStreamerExe)) {
    console.log("[assets] Using bin/webrtc-streamer alongside executable");
    STREAMER_EXE = exeBinStreamerExe;
    initialized = true;
    return { streamerExe: STREAMER_EXE };
  }

  // Path 4: Check temp extraction directory (from previous run or embedded)
  const extractDir = getExtractDir();
  const tempStreamerExe = path.join(extractDir, "webrtc-streamer.exe");

  if (fs.existsSync(tempStreamerExe)) {
    console.log("[assets] Using previously extracted asset from temp");
    STREAMER_EXE = tempStreamerExe;
    initialized = true;
    return { streamerExe: STREAMER_EXE };
  }

  // Not found anywhere
  console.log("[assets] webrtc-streamer.exe not found");
  initialized = true;
  return null;
}

/**
 * Get the streamer executable path
 */
export function getStreamerExe(): string | null {
  if (!initialized) {
    initializeAssets();
  }
  return STREAMER_EXE;
}

/**
 * Check if streaming assets are available
 */
export function areAssetsAvailable(): boolean {
  if (!initialized) {
    initializeAssets();
  }
  return STREAMER_EXE !== null;
}

/**
 * Clean up extracted assets (call on shutdown if desired)
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
