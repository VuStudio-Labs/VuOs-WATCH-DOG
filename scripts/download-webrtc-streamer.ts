/**
 * Downloads webrtc-streamer binary for Windows
 * Run with: bun scripts/download-webrtc-streamer.ts
 */

import * as fs from "fs";
import * as path from "path";

const VERSION = "v0.8.14";
const FILENAME = `webrtc-streamer-${VERSION}-dirty-Windows-AMD64-Release.tar.gz`;
const DOWNLOAD_URL = `https://github.com/mpromonet/webrtc-streamer/releases/download/${VERSION}/${FILENAME}`;
const BIN_DIR = path.join(import.meta.dir, "..", "bin");
const TAR_PATH = path.join(BIN_DIR, FILENAME);

async function main() {
  console.log("[download] webrtc-streamer setup");
  console.log(`[download] Version: ${VERSION}`);
  console.log(`[download] URL: ${DOWNLOAD_URL}`);

  // Create bin directory
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    console.log(`[download] Created ${BIN_DIR}`);
  }

  // Check if already downloaded
  const exePath = path.join(BIN_DIR, "webrtc-streamer.exe");
  if (fs.existsSync(exePath)) {
    console.log(`[download] webrtc-streamer.exe already exists at ${exePath}`);
    console.log("[download] Delete bin/ folder to re-download");
    return;
  }

  // Download
  console.log("[download] Downloading...");
  const response = await fetch(DOWNLOAD_URL);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(TAR_PATH, Buffer.from(buffer));
  console.log(`[download] Saved to ${TAR_PATH} (${Math.round(buffer.byteLength / 1024 / 1024)}MB)`);

  // Extract using tar (available on Windows 10+)
  console.log("[download] Extracting...");
  const proc = Bun.spawn(["tar", "-xzf", FILENAME], {
    cwd: BIN_DIR,
    stdio: ["ignore", "inherit", "inherit"],
  });
  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error(`Extraction failed with exit code ${proc.exitCode}`);
  }

  // Find the extracted folder and move exe to bin root
  const entries = fs.readdirSync(BIN_DIR);
  const extractedDir = entries.find(e => e.startsWith("webrtc-streamer-") && fs.statSync(path.join(BIN_DIR, e)).isDirectory());

  if (extractedDir) {
    // Structure is: extractedDir/bin/webrtc-streamer.exe and extractedDir/share/webrtc-streamer/html
    const srcExe = path.join(BIN_DIR, extractedDir, "bin", "webrtc-streamer.exe");
    if (fs.existsSync(srcExe)) {
      fs.renameSync(srcExe, exePath);
      console.log(`[download] Moved exe to ${exePath}`);

      // Copy html folder for web player
      const srcHtml = path.join(BIN_DIR, extractedDir, "share", "webrtc-streamer", "html");
      const dstHtml = path.join(BIN_DIR, "html");
      if (fs.existsSync(srcHtml)) {
        fs.cpSync(srcHtml, dstHtml, { recursive: true });
        console.log(`[download] Copied html folder to ${dstHtml}`);
      }

      // Cleanup
      fs.rmSync(path.join(BIN_DIR, extractedDir), { recursive: true });
      fs.rmSync(TAR_PATH);
      console.log("[download] Cleaned up temp files");
    }
  }

  // Verify
  if (fs.existsSync(exePath)) {
    console.log("[download] Success! webrtc-streamer.exe ready");
    console.log(`[download] Location: ${exePath}`);
  } else {
    throw new Error("webrtc-streamer.exe not found after extraction");
  }
}

main().catch((err) => {
  console.error("[download] Error:", err.message);
  process.exit(1);
});
