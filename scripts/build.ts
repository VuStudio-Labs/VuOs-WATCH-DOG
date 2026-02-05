/**
 * Build script for vu-watchdog
 *
 * Compiles the watchdog and creates a distribution folder with all required files
 */

import * as path from "path";
import * as fs from "fs";

const ROOT = path.join(import.meta.dir, "..");
const BIN_DIR = path.join(ROOT, "bin");
const DIST_DIR = path.join(ROOT, "dist");
const ICO_FILE = path.join(ROOT, "logo.ico");

// Check if webrtc-streamer exists
const streamerExe = path.join(BIN_DIR, "webrtc-streamer.exe");

if (!fs.existsSync(streamerExe)) {
  console.error("[build] ERROR: bin/webrtc-streamer.exe not found");
  console.error("[build] Run: bun scripts/download-webrtc-streamer.ts");
  process.exit(1);
}

console.log("[build] Compiling vu-watchdog.exe...");

// Use temp name to avoid conflict with running exe
const TEMP_EXE = path.join(ROOT, "vu-watchdog-new.exe");

// Run bun build
const result = Bun.spawnSync([
  "bun", "build", "--compile",
  "src/index.ts",
  "--outfile", "vu-watchdog-new.exe"
], {
  cwd: ROOT,
  stdio: ["inherit", "inherit", "inherit"],
});

if (result.exitCode !== 0) {
  console.error("[build] Compilation failed");
  process.exit(1);
}

console.log("[build] Compilation successful");

// Apply icon
console.log("[build] Setting icon...");
try {
  const { rcedit } = await import("rcedit");
  await rcedit(TEMP_EXE, { icon: ICO_FILE });
  console.log("[build] Icon applied");
} catch (err: any) {
  console.warn("[build] Warning: Could not set icon:", err.message);
}

// Create distribution folder
console.log("[build] Creating distribution folder...");

if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

// Copy exe (rename to final name)
fs.copyFileSync(TEMP_EXE, path.join(DIST_DIR, "vu-watchdog.exe"));

// Copy webrtc-streamer.exe alongside (no bin/ subfolder needed now)
fs.copyFileSync(streamerExe, path.join(DIST_DIR, "webrtc-streamer.exe"));

// Clean up temp exe
try {
  fs.unlinkSync(TEMP_EXE);
} catch {}

// Show summary
const watchdogStats = fs.statSync(path.join(DIST_DIR, "vu-watchdog.exe"));
const streamerStats = fs.statSync(path.join(DIST_DIR, "webrtc-streamer.exe"));
const watchdogSizeMB = (watchdogStats.size / 1024 / 1024).toFixed(2);
const streamerSizeMB = (streamerStats.size / 1024 / 1024).toFixed(2);
const totalSizeMB = ((watchdogStats.size + streamerStats.size) / 1024 / 1024).toFixed(2);

// Create zip archive for easy distribution
console.log("[build] Creating zip archive...");
const zipPath = path.join(ROOT, "vu-watchdog-dist.zip");

// Use PowerShell to create zip (available on all Windows systems)
const zipResult = Bun.spawnSync([
  "powershell", "-Command",
  `Compress-Archive -Path '${DIST_DIR}\\*' -DestinationPath '${zipPath}' -Force`
], {
  cwd: ROOT,
  stdio: ["inherit", "inherit", "inherit"],
});

if (zipResult.exitCode === 0) {
  const zipStats = fs.statSync(zipPath);
  const zipSizeMB = (zipStats.size / 1024 / 1024).toFixed(2);
  console.log(`[build] Created: vu-watchdog-dist.zip (${zipSizeMB} MB)`);
}

console.log("");
console.log("[build] Done!");
console.log(`[build] Distribution: dist/`);
console.log(`[build]   vu-watchdog.exe       (${watchdogSizeMB} MB)`);
console.log(`[build]   webrtc-streamer.exe   (${streamerSizeMB} MB)`);
console.log(`[build]   Total: ${totalSizeMB} MB`);
console.log("");
console.log("[build] To deploy: Copy both .exe files to the target machine (same folder)");
