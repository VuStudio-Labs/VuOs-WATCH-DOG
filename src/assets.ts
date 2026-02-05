/**
 * Embedded asset management for compiled executable
 *
 * In development: Uses bin/ directory relative to cwd
 * In production (compiled exe): Extracts embedded assets to temp directory
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Asset paths - resolved at initialization
let STREAMER_EXE: string | null = null;
let HTML_DIR: string | null = null;
let initialized = false;

// Check if running as compiled executable
function isCompiledExe(): boolean {
  // Bun compiled executables have a special marker
  return !!process.pkg || process.argv[0].endsWith(".exe") && !process.argv[0].includes("bun");
}

// Get the extraction directory for embedded assets
function getExtractDir(): string {
  return path.join(os.tmpdir(), "vu-watchdog-bin");
}

// Copy directory recursively
function copyDirSync(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Initialize asset paths
 * Call this at startup before using streaming
 */
export function initializeAssets(): { streamerExe: string; htmlDir: string } | null {
  if (initialized && STREAMER_EXE && HTML_DIR) {
    return { streamerExe: STREAMER_EXE, htmlDir: HTML_DIR };
  }

  // Path 1: Development mode - bin/ relative to cwd
  const devBinDir = path.join(process.cwd(), "bin");
  const devStreamerExe = path.join(devBinDir, "webrtc-streamer.exe");
  const devHtmlDir = path.join(devBinDir, "html");

  if (fs.existsSync(devStreamerExe) && fs.existsSync(devHtmlDir)) {
    console.log("[assets] Using development bin/ directory");
    STREAMER_EXE = devStreamerExe;
    HTML_DIR = devHtmlDir;
    initialized = true;
    return { streamerExe: STREAMER_EXE, htmlDir: HTML_DIR };
  }

  // Path 2: Compiled exe - check alongside executable
  const exeDir = path.dirname(process.execPath);
  const exeBinDir = path.join(exeDir, "bin");
  const exeStreamerExe = path.join(exeBinDir, "webrtc-streamer.exe");
  const exeHtmlDir = path.join(exeBinDir, "html");

  if (fs.existsSync(exeStreamerExe) && fs.existsSync(exeHtmlDir)) {
    console.log("[assets] Using bin/ directory alongside executable");
    STREAMER_EXE = exeStreamerExe;
    HTML_DIR = exeHtmlDir;
    initialized = true;
    return { streamerExe: STREAMER_EXE, htmlDir: HTML_DIR };
  }

  // Path 3: Check temp extraction directory (from previous run)
  const extractDir = getExtractDir();
  const tempStreamerExe = path.join(extractDir, "webrtc-streamer.exe");
  const tempHtmlDir = path.join(extractDir, "html");

  if (fs.existsSync(tempStreamerExe) && fs.existsSync(tempHtmlDir)) {
    console.log("[assets] Using previously extracted assets from temp");
    STREAMER_EXE = tempStreamerExe;
    HTML_DIR = tempHtmlDir;
    initialized = true;
    return { streamerExe: STREAMER_EXE, htmlDir: HTML_DIR };
  }

  // Path 4: Embedded assets (Bun compile with --asset)
  // When compiled with --asset, files are accessible relative to import.meta.dir
  try {
    const embeddedBinDir = path.join(import.meta.dir, "..", "bin");
    const embeddedStreamerExe = path.join(embeddedBinDir, "webrtc-streamer.exe");
    const embeddedHtmlDir = path.join(embeddedBinDir, "html");

    if (fs.existsSync(embeddedStreamerExe) && fs.existsSync(embeddedHtmlDir)) {
      console.log("[assets] Found embedded assets, extracting to temp...");

      // Extract to temp for reliable execution
      if (!fs.existsSync(extractDir)) {
        fs.mkdirSync(extractDir, { recursive: true });
      }

      // Copy streamer exe
      fs.copyFileSync(embeddedStreamerExe, tempStreamerExe);

      // Copy html directory
      copyDirSync(embeddedHtmlDir, tempHtmlDir);

      console.log(`[assets] Extracted to ${extractDir}`);

      STREAMER_EXE = tempStreamerExe;
      HTML_DIR = tempHtmlDir;
      initialized = true;
      return { streamerExe: STREAMER_EXE, htmlDir: HTML_DIR };
    }
  } catch (err) {
    // Embedded assets not available
  }

  // Not found anywhere
  console.log("[assets] webrtc-streamer not found");
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
 * Get the HTML directory path
 */
export function getHtmlDir(): string | null {
  if (!initialized) {
    initializeAssets();
  }
  return HTML_DIR;
}

/**
 * Check if streaming assets are available
 */
export function areAssetsAvailable(): boolean {
  if (!initialized) {
    initializeAssets();
  }
  return STREAMER_EXE !== null && HTML_DIR !== null;
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
