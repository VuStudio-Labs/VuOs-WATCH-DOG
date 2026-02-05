/**
 * Build script for vu-watchdog
 * Creates a single exe with embedded webrtc-streamer
 */

import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(import.meta.dir, "..");
const BIN_DIR = path.join(ROOT, "bin");
const DIST_DIR = path.join(ROOT, "dist");
const ICO_FILE = path.join(ROOT, "logo.ico");
const STREAMER_EXE = path.join(BIN_DIR, "webrtc-streamer.exe");
const EMBEDDED_TS = path.join(ROOT, "src", "embedded-streamer.ts");

// Check if webrtc-streamer exists
if (!fs.existsSync(STREAMER_EXE)) {
  console.error("[build] ERROR: bin/webrtc-streamer.exe not found");
  console.error("[build] Run: bun scripts/download-webrtc-streamer.ts");
  process.exit(1);
}

// Embed the streamer as base64
console.log("[build] Embedding webrtc-streamer.exe...");

const buffer = fs.readFileSync(STREAMER_EXE);
const base64 = buffer.toString("base64");
const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);

console.log(`[build] Embedding ${sizeMB} MB binary...`);

const embeddedCode = `/**
 * AUTO-GENERATED - DO NOT EDIT
 * Contains webrtc-streamer.exe as embedded base64
 */

export const STREAMER_SIZE = ${buffer.length};
export const STREAMER_BASE64 = "${base64}";
`;

fs.writeFileSync(EMBEDDED_TS, embeddedCode);

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
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

// Copy exe
fs.copyFileSync(TEMP_EXE, path.join(DIST_DIR, "vu-watchdog.exe"));

// Clean up
try {
  fs.unlinkSync(TEMP_EXE);
  fs.unlinkSync(EMBEDDED_TS);
} catch {}

// Show summary
const watchdogStats = fs.statSync(path.join(DIST_DIR, "vu-watchdog.exe"));
const watchdogSizeMB = (watchdogStats.size / 1024 / 1024).toFixed(2);

// Create zip
console.log("[build] Creating zip...");
const zipPath = path.join(ROOT, "vu-watchdog.zip");

Bun.spawnSync([
  "powershell", "-Command",
  `Compress-Archive -Path '${DIST_DIR}\\*' -DestinationPath '${zipPath}' -Force`
], { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] });

const zipStats = fs.statSync(zipPath);
const zipSizeMB = (zipStats.size / 1024 / 1024).toFixed(2);

console.log("");
console.log("[build] Done!");
console.log(`[build] Single exe: dist/vu-watchdog.exe (${watchdogSizeMB} MB)`);
console.log(`[build] Zip: vu-watchdog.zip (${zipSizeMB} MB)`);
console.log("");
console.log("[build] First run extracts streamer to %TEMP%\\vu-watchdog-bin\\");
