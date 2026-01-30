/**
 * Converts logo.svg → logo.ico with multiple sizes for Windows exe icon.
 * Run: bun scripts/build-ico.ts
 */
import { Resvg } from "@resvg/resvg-js";
import * as fs from "fs";
import * as path from "path";

const SVG_PATH = path.join(import.meta.dir, "..", "logo.svg");
const ICO_PATH = path.join(import.meta.dir, "..", "logo.ico");
const SIZES = [16, 32, 48, 256];

const svg = fs.readFileSync(SVG_PATH, "utf-8");

// Render SVG to PNG at each size
const pngs: Buffer[] = SIZES.map((size) => {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0,0,0,0)",
  });
  const rendered = resvg.render();
  return Buffer.from(rendered.asPng());
});

// Build ICO file
// ICO format: header (6 bytes) + entries (16 bytes each) + image data
const headerSize = 6;
const entrySize = 16;
const dataOffset = headerSize + entrySize * SIZES.length;

// Header
const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0);      // reserved
header.writeUInt16LE(1, 2);      // type: 1 = ICO
header.writeUInt16LE(SIZES.length, 4); // image count

// Entries + data
const entries: Buffer[] = [];
let currentOffset = dataOffset;

for (let i = 0; i < SIZES.length; i++) {
  const entry = Buffer.alloc(entrySize);
  const size = SIZES[i];
  entry.writeUInt8(size >= 256 ? 0 : size, 0);   // width (0 = 256)
  entry.writeUInt8(size >= 256 ? 0 : size, 1);   // height (0 = 256)
  entry.writeUInt8(0, 2);           // color palette
  entry.writeUInt8(0, 3);           // reserved
  entry.writeUInt16LE(1, 4);        // color planes
  entry.writeUInt16LE(32, 6);       // bits per pixel
  entry.writeUInt32LE(pngs[i].length, 8);   // image size
  entry.writeUInt32LE(currentOffset, 12);   // offset
  entries.push(entry);
  currentOffset += pngs[i].length;
}

const ico = Buffer.concat([header, ...entries, ...pngs]);
fs.writeFileSync(ICO_PATH, ico);
console.log(`[ico] Written ${ICO_PATH} (${SIZES.join(", ")}px, ${ico.length} bytes)`);
