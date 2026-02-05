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
const OUT_EXE = path.join(ROOT, "vu-watchdog.exe");
const ICO_FILE = path.join(ROOT, "logo.ico");

// Check if bin/ folder exists with required assets
const streamerExe = path.join(BIN_DIR, "webrtc-streamer.exe");
const htmlDir = path.join(BIN_DIR, "html");

if (!fs.existsSync(streamerExe)) {
  console.error("[build] ERROR: bin/webrtc-streamer.exe not found");
  console.error("[build] Run: bun scripts/download-webrtc-streamer.ts");
  process.exit(1);
}

if (!fs.existsSync(htmlDir)) {
  console.error("[build] ERROR: bin/html/ not found");
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

// Clean up temp exe
try {
  fs.unlinkSync(TEMP_EXE);
} catch {}

// Copy bin folder
function copyDirSync(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // Skip .git directory
    if (entry.name === ".git") continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyDirSync(BIN_DIR, path.join(DIST_DIR, "bin"));

// Show summary
const exeStats = fs.statSync(path.join(DIST_DIR, "vu-watchdog.exe"));
const exeSizeMB = (exeStats.size / 1024 / 1024).toFixed(2);

// Calculate total dist size
function getDirSize(dir: string): number {
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    } else {
      size += fs.statSync(fullPath).size;
    }
  }
  return size;
}

const totalSize = getDirSize(DIST_DIR);
const totalSizeMB = (totalSize / 1024 / 1024).toFixed(2);

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
console.log(`[build]   vu-watchdog.exe (${exeSizeMB} MB)`);
console.log(`[build]   bin/ (streaming assets)`);
console.log(`[build]   Total: ${totalSizeMB} MB`);
console.log("");
console.log("[build] To deploy:");
console.log("[build]   Option 1: Copy the entire dist/ folder to the target machine");
console.log("[build]   Option 2: Extract vu-watchdog-dist.zip to the target machine");
