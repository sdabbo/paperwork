// The iPhone's launch screens for the home-screen app: one flat image per screen size, in the app's canvas color
// for light and for dark mode, so opening the app goes from the launch screen to the splash screen (index.html)
// without a visible step. iOS ignores the manifest's background_color and shows these instead.
//
//   node scripts/launch-images.mjs
//
// Writes the images to public/icons/launch/ and their <link>s into index.html (between the launch-images
// comments). Needs nothing but Node. Only needed again when a color or the list of screens changes; the images are
// committed. Safari reads them when the app is added to the home screen, so after a change: remove Paperwork from
// the home screen and add it again.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public/icons/launch');

// The canvas colors (src/index.css --canvas), the same as the splash screen's background
const COLORS = { light: '#f6f6f4', dark: '#111214' };

// iPhone screens in portrait, in points, and their pixel ratio. A screen not listed gets a plain white or black
// launch screen.
const SCREENS = [
  [440, 956, 3], // 16 Pro Max, 17 Pro Max
  [420, 912, 3], // Air
  [402, 874, 3], // 16 Pro, 17, 17 Pro
  [430, 932, 3], // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  [393, 852, 3], // 14 Pro, 15, 15 Pro, 16
  [428, 926, 3], // 12 Pro Max, 13 Pro Max, 14 Plus
  [390, 844, 3], // 12, 12 Pro, 13, 13 Pro, 14, 16e
  [375, 812, 3], // X, XS, 11 Pro, 12 mini, 13 mini
  [414, 896, 3], // XS Max, 11 Pro Max
  [414, 896, 2], // XR, 11
  [375, 667, 2], // SE (2nd and 3rd generation)
];

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

// A flat PNG: one palette color, one bit per pixel, so a full-screen image is well under a kilobyte
function flatPng(width, height, hex) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([1, 3, 0, 0, 0], 8); // bit depth 1, palette, deflate, no filter, not interlaced
  const row = 1 + Math.ceil(width / 8); // filter byte, then the pixels (all palette entry 0)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('sRGB', Buffer.from([0])), // the same color space as the page's CSS colors
    chunk('PLTE', Buffer.from(hex.slice(1), 'hex')),
    chunk('IDAT', deflateSync(Buffer.alloc(row * height), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const links = [];
let bytes = 0;
for (const [scheme, color] of Object.entries(COLORS)) {
  for (const [w, h, ratio] of SCREENS) {
    const name = `${scheme}-${w * ratio}x${h * ratio}.png`;
    const png = flatPng(w * ratio, h * ratio, color);
    writeFileSync(join(outDir, name), png);
    bytes += png.length;
    const media = `(prefers-color-scheme: ${scheme}) and (device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: portrait)`;
    links.push(`    <link rel="apple-touch-startup-image" media="${media}" href="/icons/launch/${name}" />`);
  }
}

const indexPath = join(root, 'index.html');
const index = readFileSync(indexPath, 'utf8');
const block = /( *)(<!-- launch-images:start[^>]*-->)[\s\S]*?<!-- launch-images:end -->/;
if (!block.test(index)) throw new Error('index.html has no <!-- launch-images:start --> … <!-- launch-images:end --> block');
writeFileSync(indexPath, index.replace(block, (_, indent, start) => [indent + start, ...links, `${indent}<!-- launch-images:end -->`].join('\n')));

console.log(`${links.length} launch images (${(bytes / 1024).toFixed(1)} KB) in public/icons/launch, linked in index.html`);
