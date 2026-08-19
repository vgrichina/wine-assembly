#!/usr/bin/env node
// Pyramid menu/playability regression.
//
// Pyramid's first Start! command creates the visible board, but the deal is
// not normally interactive until Game > New runs. Drive that path through the
// real mouse menu hit-test and verify a free card can then be selected.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'wep32-community', 'Funpack', 'Pyramid.exe');
const DLL = path.join(__dirname, 'binaries', 'wep32-community', 'Funpack', 'FunPack.dll');
const OUT = path.join(ROOT, 'scratch');
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(EXE) || !fs.existsSync(DLL)) {
  console.log('SKIP  Pyramid.exe/FunPack.dll missing');
  process.exit(0);
}

const afterNewPng = path.join(OUT, 'pyramid_after_menu_new.png');
const afterSelectPng = path.join(OUT, 'pyramid_after_select.png');
for (const p of [afterNewPng, afterSelectPng]) {
  try { fs.unlinkSync(p); } catch (_) {}
}

const inputSpec = [
  '5:0x111:40003',             // top-level Start! creates the Pyramid window
  '20:mousedown:42:52',        // open Game menu through renderer/WAT hit-test
  '21:mouseup:42:52',
  '25:menu-dump:game',
  '30:mousedown:57:72',        // Game > New
  '31:mouseup:57:72',
  `60:png:${afterNewPng}`,
  '70:mousedown:160:370',      // free bottom-row card
  '71:mouseup:160:370',
  `100:png:${afterSelectPng}`,
  '110:stop',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--dlls=${DLL}`,
  '--no-close',
  `--input=${inputSpec}`,
  '--max-batches=120',
  '--batch-size=50000',
  '--quiet-api',
  '--quiet-blocks',
];

console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));

let out = '';
let exitCode = 0;
try {
  out = execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  exitCode = e.status ?? 1;
  console.log(`(run.js exited non-zero status=${exitCode} - output captured)`);
}

for (const line of out.split('\n')) {
  if (/\[input\]|menu-dump|STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED/.test(line)) {
    console.log('  ' + line);
  }
}

async function readPixels(file) {
  const img = await loadImage(file);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}

function countInRect(img, rect, pred) {
  let count = 0;
  for (let y = rect.y0; y < Math.min(rect.y1, img.h); y++) {
    for (let x = rect.x0; x < Math.min(rect.x1, img.w); x++) {
      const i = (y * img.w + x) * 4;
      if (pred(img.data[i], img.data[i + 1], img.data[i + 2], x, y)) count++;
    }
  }
  return count;
}

(async () => {
  const afterNewSize = fs.existsSync(afterNewPng) ? fs.statSync(afterNewPng).size : 0;
  const afterSelectSize = fs.existsSync(afterSelectPng) ? fs.statSync(afterSelectPng).size : 0;
  let blackBefore = 0;
  let blackAfter = 0;
  let whiteBefore = 0;
  let whiteAfter = 0;
  let changedPixels = 0;
  if (afterNewSize && afterSelectSize) {
    const before = await readPixels(afterNewPng);
    const after = await readPixels(afterSelectPng);
    const selectedCard = { x0: 126, y0: 324, x1: 198, y1: 419 };
    blackBefore = countInRect(before, selectedCard, (r, g, b) => r < 20 && g < 20 && b < 20);
    blackAfter = countInRect(after, selectedCard, (r, g, b) => r < 20 && g < 20 && b < 20);
    whiteBefore = countInRect(before, selectedCard, (r, g, b) => r > 235 && g > 235 && b > 235);
    whiteAfter = countInRect(after, selectedCard, (r, g, b) => r > 235 && g > 235 && b > 235);
    changedPixels = countInRect(after, selectedCard, (_, __, ___, x, y) => {
      const i = (y * after.w + x) * 4;
      return Math.abs(before.data[i] - after.data[i]) +
        Math.abs(before.data[i + 1] - after.data[i + 1]) +
        Math.abs(before.data[i + 2] - after.data[i + 2]) > 60;
    });
  }

  const checks = [
    { name: 'bounded run exited cleanly', pass: exitCode === 0 },
    { name: 'Pyramid window was created by Start!', pass: /\[CreateWindow\].*title="Pyramid"/.test(out) },
    { name: 'real mouse click opened Game menu', pass: /menu-dump:game: hwnd=0x10001 top=0/.test(out) },
    { name: 'Game menu contains New command', pass: /id=40001[^\n]*"&New"/.test(out) },
    { name: 'real mouse click selected Game > New', pass: /mousedown 57,72/.test(out) && /mouseup 57,72/.test(out) },
    { name: 'after-New PNG written', pass: afterNewSize > 10000 },
    { name: 'after-select PNG written', pass: afterSelectSize > 10000 },
    { name: 'free card responds to click', pass: changedPixels > 3000 || (blackAfter - blackBefore > 3000 && whiteBefore - whiteAfter > 3000) },
    { name: 'no crash marker', pass: !/STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/.test(out) },
  ];

  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log(`pngs: afterNew=${afterNewSize} afterSelect=${afterSelectSize} changed=${changedPixels} black=${blackBefore}->${blackAfter} white=${whiteBefore}->${whiteAfter}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
