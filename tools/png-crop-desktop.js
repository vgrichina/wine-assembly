#!/usr/bin/env node
// Crop a screenshot to its window: drop the desktop-teal margin around what
// the app actually drew.
//
//   node tools/png-crop-desktop.js <in.png> [<in.png> ...] [--out=DIR] [--pad=N]
//        [--max-fill=0.9] [--dry-run]
//
// A headless capture is the whole 640x480 desktop, and a Notepad or a
// Minesweeper occupies a fifth of it: the rest is Win98 teal (0,128,128),
// which on an app page or a search result is wasted pixels around a small
// window. This finds the bounding box of every pixel that is not the desktop
// colour, pads it, and writes the crop. Files are rewritten in place unless
// --out names a directory.
//
// A capture whose content already fills the frame (a full-screen game, a
// maximized window) is left alone: if the content box covers more than
// --max-fill of the frame (default 0.9) there is nothing to gain and the crop
// would only shave a border. The test is area, not margin, because a window
// parked at 0,0 has a zero margin on two sides and a lot of teal on the other
// two. --dry-run prints the boxes and writes nothing.
//
// Exact-colour matching is deliberate: the desktop is flat teal and nothing an
// app draws is that exact value by accident often enough to matter, and a
// tolerance would start eating dark-green card tables.

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const DESKTOP = [0, 128, 128];

function contentBox(png) {
  const { width, height, data } = png;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i] === DESKTOP[0] && data[i + 1] === DESKTOP[1] && data[i + 2] === DESKTOP[2]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

function cropPng(png, box, pad) {
  const x0 = Math.max(0, box.x0 - pad), y0 = Math.max(0, box.y0 - pad);
  const x1 = Math.min(png.width - 1, box.x1 + pad), y1 = Math.min(png.height - 1, box.y1 + pad);
  const out = new PNG({ width: x1 - x0 + 1, height: y1 - y0 + 1 });
  PNG.bitblt(png, out, x0, y0, out.width, out.height, 0, 0);
  return out;
}

function cropFile(file, { pad = 8, maxFill = 0.9, outDir = null, dryRun = false } = {}) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const box = contentBox(png);
  if (!box) return { file, action: 'skip', reason: 'all desktop colour' };
  const fill = ((box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1)) / (png.width * png.height);
  if (fill > maxFill) return { file, action: 'keep', reason: `fills ${(fill * 100).toFixed(0)}%`, box };
  const out = cropPng(png, box, pad);
  const dest = outDir ? path.join(outDir, path.basename(file)) : file;
  if (!dryRun) fs.writeFileSync(dest, PNG.sync.write(out));
  return { file, action: 'crop', box, from: `${png.width}x${png.height}`, to: `${out.width}x${out.height}`, dest };
}

module.exports = { contentBox, cropFile, DESKTOP };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const a = args.find(s => s.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
  const files = args.filter(a => !a.startsWith('--'));
  if (!files.length) { console.error('usage: png-crop-desktop.js <png> [...] [--out=DIR] [--pad=N] [--max-fill=0.9] [--dry-run]'); process.exit(2); }
  const outDir = opt('out', null);
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const o = { pad: +opt('pad', 8), maxFill: +opt('max-fill', 0.9), outDir, dryRun: args.includes('--dry-run') };
  for (const f of files) {
    const r = cropFile(f, o);
    const tag = r.action === 'crop' ? `${r.from} -> ${r.to}` : r.reason;
    console.log(`${r.action.padEnd(5)} ${path.basename(f)}  ${tag}`);
  }
}
