#!/usr/bin/env node

// Print the RGBA of chosen pixels in a PNG.
//
//   node tools/png-probe.js <file.png> [x,y ...]
//   node tools/png-probe.js <file.png> --histogram [--top=N]
//
// Reach for this on any --dump-gdi / --png output where the question is what
// a region actually contains. A viewer composites alpha against its own
// background, so a fully transparent surface and a black one look identical
// on screen and completely different to the compositor -- "the bitmap came
// out black" and "the bitmap was never written" are the same picture until
// you read the alpha.
//
// With no pixel list it samples the four corners and the centre.

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error('usage: node tools/png-probe.js <file.png> [x,y ...] [--histogram] [--top=N]');
  process.exit(message ? 1 : 0);
}

const args = process.argv.slice(2);
if (!args.length || args[0] === '--help' || args[0] === '-h') usage();

const file = args[0];
if (!fs.existsSync(file)) usage(`no such file: ${file}`);
const histogram = args.includes('--histogram');
const topArg = args.find(a => a.startsWith('--top='));
const top = topArg ? parseInt(topArg.slice(6), 10) : 8;

const points = [];
for (const arg of args.slice(1)) {
  if (arg.startsWith('--')) continue;
  const [x, y] = arg.split(',').map(v => parseInt(v, 10));
  if (!Number.isFinite(x) || !Number.isFinite(y)) usage(`bad pixel "${arg}", want x,y`);
  points.push([x, y]);
}

const png = PNG.sync.read(fs.readFileSync(file));
console.log(`${path.basename(file)}  ${png.width}x${png.height}`);

const at = (x, y) => {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
};
const show = (label, x, y) => {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
    console.log(`  ${label} (${x},${y})  outside the image`);
    return;
  }
  const [r, g, b, a] = at(x, y);
  const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  console.log(`  ${label} (${x},${y})  rgba(${r},${g},${b},${a})  ${hex}` +
    (a === 0 ? '  TRANSPARENT' : a !== 255 ? `  alpha ${a}/255` : ''));
};

if (points.length) {
  for (const [x, y] of points) show('pixel', x, y);
} else if (!histogram) {
  const w = png.width - 1, h = png.height - 1;
  show('top-left    ', 0, 0);
  show('top-right   ', w, 0);
  show('bottom-left ', 0, h);
  show('bottom-right', w, h);
  show('centre      ', png.width >> 1, png.height >> 1);
}

if (histogram) {
  const counts = new Map();
  for (let i = 0; i < png.data.length; i += 4) {
    const key = (png.data[i] << 24 | png.data[i + 1] << 16 |
                 png.data[i + 2] << 8 | png.data[i + 3]) >>> 0;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const total = png.width * png.height;
  console.log(`  ${counts.size} distinct colours in ${total} pixels:`);
  for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    const r = key >>> 24, g = (key >>> 16) & 255, b = (key >>> 8) & 255, a = key & 255;
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    console.log(`    rgba(${r},${g},${b},${a})  ${hex}  ${n}  ` +
      `${(n * 100 / total).toFixed(1)}%${a === 0 ? '  TRANSPARENT' : ''}`);
  }
}
