#!/usr/bin/env node
// Bricks/Klotski drag regression.
//
// Bricks calls ClipCursor while dragging and advances a piece only when the
// cursor reaches the clipped edge. The renderer must clamp mousemove coords to
// that rect; otherwise the cursor crosses past the edge and no brick moves.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'wep32-community', 'Bricks', 'bricks.exe');
const OUT = path.join(ROOT, 'scratch');
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(EXE)) {
  console.log('SKIP  bricks.exe missing');
  process.exit(0);
}

const beforePng = path.join(OUT, 'bricks_drag_before.png');
const afterPng = path.join(OUT, 'bricks_drag_after.png');
for (const p of [beforePng, afterPng]) {
  try { fs.unlinkSync(p); } catch (_) {}
}

const inputSpec = [
  '50:mousedown:240:450',
  '51:mouseup:240:450',
  `85:png:${beforePng}`,
  '95:mousedown:305:293',
  '96:mousemove:282:293',
  '97:mousemove:259:293',
  '98:mouseup:259:293',
  `125:png:${afterPng}`,
  '130:stop',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  '--no-close',
  `--input=${inputSpec}`,
  '--max-batches=150',
  '--batch-size=1000',
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
    timeout: 20000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  exitCode = e.status ?? 1;
  console.log(`(run.js exited non-zero status=${exitCode} - output captured)`);
}

for (const line of out.split('\n')) {
  if (/\[input\]|STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED/.test(line)) {
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

function countDiff(a, b, rect) {
  let diff = 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const i = (y * a.w + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) diff++;
    }
  }
  return diff;
}

(async () => {
  const beforeSize = fs.existsSync(beforePng) ? fs.statSync(beforePng).size : 0;
  const afterSize = fs.existsSync(afterPng) ? fs.statSync(afterPng).size : 0;
  let boardDiff = 0;
  if (beforeSize && afterSize) {
    const before = await readPixels(beforePng);
    const after = await readPixels(afterPng);
    boardDiff = countDiff(before, after, { x0: 185, y0: 145, x1: 330, y1: 335 });
  }

  const checks = [
    { name: 'bounded run exited cleanly', pass: exitCode === 0 },
    { name: 'board start click was injected', pass: /mousedown 240,450/.test(out) && /mouseup 240,450/.test(out) },
    { name: 'drag path was injected', pass: /mousedown 305,293/.test(out) && /mousemove 259,293/.test(out) && /mouseup 259,293/.test(out) },
    { name: 'before PNG written', pass: beforeSize > 6000 },
    { name: 'after PNG written', pass: afterSize > 6000 },
    { name: 'drag changed board pixels', pass: boardDiff > 300 },
    { name: 'no crash marker', pass: !/STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/.test(out) },
  ];

  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log(`before=${beforePng} size=${beforeSize}`);
  console.log(`after=${afterPng} size=${afterSize} boardDiff=${boardDiff}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
