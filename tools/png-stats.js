#!/usr/bin/env node
// Top colours in a PNG, with alpha — answers "what is this uniform-looking
// capture actually filled with, and is any of it transparent?".
//
// Usage: node tools/png-stats.js <file.png> [--top=N] [--region=X,Y,W,H]
const fs = require('fs');
const { PNG } = require('pngjs');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node tools/png-stats.js <file.png> [--top=N] [--region=X,Y,W,H]');
  process.exit(2);
}
const topN = parseInt((args.find(a => a.startsWith('--top=')) || '--top=8').slice(6), 10);
const regionArg = args.find(a => a.startsWith('--region='));
const png = PNG.sync.read(fs.readFileSync(file));
let [rx, ry, rw, rh] = regionArg
  ? regionArg.slice(9).split(',').map(Number)
  : [0, 0, png.width, png.height];
rx = Math.max(0, rx); ry = Math.max(0, ry);
rw = Math.min(rw, png.width - rx); rh = Math.min(rh, png.height - ry);

const counts = new Map();
let transparent = 0;
for (let y = ry; y < ry + rh; y++) {
  for (let x = rx; x < rx + rw; x++) {
    const i = (png.width * y + x) << 2;
    const a = png.data[i + 3];
    if (a === 0) transparent++;
    const key = (png.data[i] << 24) | (png.data[i + 1] << 16) | (png.data[i + 2] << 8) | a;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
}
const total = rw * rh;
console.log(`${file}  ${png.width}x${png.height}  region ${rx},${ry} ${rw}x${rh}`);
console.log(`  distinct colours: ${counts.size}   fully transparent: ${transparent} (${(100 * transparent / total).toFixed(2)}%)`);
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
for (const [key, n] of sorted) {
  const r = (key >>> 24) & 0xff, g = (key >>> 16) & 0xff, b = (key >>> 8) & 0xff, a = key & 0xff;
  const hex = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  console.log(`  ${hex} a=${a.toString().padStart(3)}  ${n} px  ${(100 * n / total).toFixed(2)}%`);
}
