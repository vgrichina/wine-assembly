#!/usr/bin/env node

'use strict';

// Inspect a region of a rendered screenshot.
//
//   node tools/png-crop.js <in.png> --rect=X,Y,W,H [--scale=N] [--out=path]
//   node tools/png-crop.js <in.png> --boxes[=Y0,Y1]   [--min=8]
//   node tools/png-crop.js <in.png> --probe=X,Y,W,H
//
// --rect crops and nearest-neighbour scales, so a control can be read pixel by
// pixel instead of squinted at. macOS `sips -c` crops from the centre and
// ignores an offset, which silently gives you the wrong region.
//
// --probe prints the region as a grid of one-character symbols with a legend
// giving each symbol's exact color, naming the Win98 system colors it knows.
// Chrome work turns on questions like "is that outermost row face or white",
// which a zoomed image answers by eye and therefore not at all.
//
// --boxes reports the rectangles of Win98 control borders in a band of rows,
// found by scanning for the white edge runs a raised BUTTON draws. Use it to
// answer "what is actually on screen and where" without reading the pixels
// yourself - a duplicated or misplaced control shows up as an extra row in
// the report.

const fs = require('fs');
const path = require('path');

let PNG;
try { ({ PNG } = require('pngjs')); } catch (_) {
  console.error('pngjs is required: npm install pngjs');
  process.exit(1);
}

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error(fs.readFileSync(__filename, 'utf8')
    .split('\n').slice(4, 18).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(2);
}
const argOf = (name, fallback) => {
  const hit = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

const png = PNG.sync.read(fs.readFileSync(file));
const at = (x, y) => {
  const i = (y * png.width + x) * 4;
  return (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2];
};

const probe = argOf('probe');
if (probe) {
  const NAMES = new Map([
    [0xFFFFFF, '3DHILIGHT/white'],
    [0xC0C0C0, '3DFACE'],
    [0x808080, '3DSHADOW'],
    [0xDFDFDF, '3DLIGHT'],
    [0x000000, '3DDKSHADOW/black'],
    [0x000080, 'ACTIVECAPTION'],
    [0x1084D0, 'GRADIENTACTIVECAPTION'],
    [0x008080, 'desktop teal'],
  ]);
  const [px, py, pw, ph] = probe.split(',').map(Number);
  const symbols = '#o+=-:*%&$@abcdefghijklmnpqrstuvwxyz';
  const seen = new Map();
  const rows = [];
  for (let y = py; y < Math.min(py + ph, png.height); y += 1) {
    let row = '';
    for (let x = px; x < Math.min(px + pw, png.width); x += 1) {
      const color = at(x, y);
      if (!seen.has(color)) {
        seen.set(color, seen.size < symbols.length ? symbols[seen.size] : '?');
      }
      row += seen.get(color);
    }
    rows.push(`${String(y).padStart(4)} ${row}`);
  }
  console.log(`${path.basename(file)} ${png.width}x${png.height}  probe ${px},${py} ${pw}x${ph}`);
  for (const [color, symbol] of seen) {
    const hex = `#${color.toString(16).padStart(6, '0')}`;
    console.log(`  ${symbol} = ${hex}${NAMES.has(color) ? `  ${NAMES.get(color)}` : ''}`);
  }
  console.log(`     ${'x'.padEnd(1)}${String(px)} ->`);
  for (const row of rows) console.log(row);
  process.exit(0);
}

const boxes = argOf('boxes');
if (boxes) {
  // A raised Win98 border is a white top/left edge over a face-coloured fill.
  // Scanning for horizontal runs of white finds the top edge of every raised
  // control, which is enough to locate and size them.
  const WHITE = 0xFFFFFF;
  const MIN = parseInt(argOf('min', '8'), 10);
  const [y0, y1] = boxes === true
    ? [0, png.height - 1]
    : boxes.split(',').map(Number);
  const found = [];
  for (let y = y0; y <= Math.min(y1, png.height - 1); y += 1) {
    let x = 0;
    while (x < png.width) {
      if (at(x, y) !== WHITE) { x += 1; continue; }
      const start = x;
      while (x < png.width && at(x, y) === WHITE) x += 1;
      const width = x - start;
      if (width < MIN) continue;
      // Height: follow the white left edge down from this row.
      let height = 1;
      while (y + height < png.height && at(start, y + height) === WHITE) height += 1;
      if (height < 4) continue;
      found.push({ x: start, y, w: width, h: height });
    }
  }
  // Collapse rows that are the same control found on consecutive scanlines.
  const kept = [];
  for (const box of found) {
    const dup = kept.find(k => Math.abs(k.x - box.x) <= 2
      && Math.abs(k.y - box.y) <= 2 && Math.abs(k.w - box.w) <= 2);
    if (!dup) kept.push(box);
  }
  console.log(`${path.basename(file)} ${png.width}x${png.height}`);
  for (const box of kept) {
    console.log(`  x=${box.x}\ty=${box.y}\tw=${box.w}\th=${box.h}`);
  }
  process.exit(0);
}

const rect = argOf('rect');
if (!rect) {
  console.error('need --rect=X,Y,W,H or --boxes');
  process.exit(2);
}
const [rx, ry, rw, rh] = rect.split(',').map(Number);
const scale = parseInt(argOf('scale', '1'), 10);
const out = argOf('out', file.replace(/\.png$/, '') + `-crop.png`);

const cropped = new PNG({ width: rw * scale, height: rh * scale });
for (let y = 0; y < rh * scale; y += 1) {
  for (let x = 0; x < rw * scale; x += 1) {
    const sx = Math.min(png.width - 1, rx + Math.floor(x / scale));
    const sy = Math.min(png.height - 1, ry + Math.floor(y / scale));
    const from = (sy * png.width + sx) * 4;
    const to = (y * (rw * scale) + x) * 4;
    cropped.data[to] = png.data[from];
    cropped.data[to + 1] = png.data[from + 1];
    cropped.data[to + 2] = png.data[from + 2];
    cropped.data[to + 3] = 0xFF;
  }
}
fs.writeFileSync(out, PNG.sync.write(cropped));
console.log(`${rw}x${rh} at ${rx},${ry} scaled ${scale}x -> ${out}`);
