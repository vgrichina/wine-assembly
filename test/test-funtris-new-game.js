#!/usr/bin/env node
// Funtris New menu regression.
//
// Drives the real menu click path and writes a PNG that should show the
// playfield, score panel, and next-brick preview after New starts.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'wep32-community', 'Funpack', 'Funtris.exe');
const OUT = path.join(ROOT, 'scratch');
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(EXE)) {
  console.log('SKIP  Funtris.exe missing');
  process.exit(0);
}

const png = path.join(OUT, 'funtris_new_game.png');
try { fs.unlinkSync(png); } catch (_) {}

const inputSpec = [
  '100:mousedown:244:152',
  '101:mouseup:244:152',
  '3800:mousedown:44:52',
  '3801:mouseup:44:52',
  '3810:mousedown:56:72',
  '3811:mouseup:56:72',
  `3830:png:${png}`,
  '3840:stop',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  '--no-close',
  `--input=${inputSpec}`,
  '--max-batches=3850',
  '--batch-size=100',
  '--stuck-after=100',
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
    maxBuffer: 64 * 1024 * 1024,
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

function countInRect(img, rect, pred) {
  let count = 0;
  for (let y = rect.y0; y < Math.min(rect.y1, img.h); y++) {
    for (let x = rect.x0; x < Math.min(rect.x1, img.w); x++) {
      const i = (y * img.w + x) * 4;
      if (pred(img.data[i], img.data[i + 1], img.data[i + 2])) count++;
    }
  }
  return count;
}

(async () => {
  const pngSize = fs.existsSync(png) ? fs.statSync(png).size : 0;
  let redPreview = 0;
  let greenPiece = 0;
  let scorePanelFace = 0;
  let playfieldBlack = 0;
  if (pngSize) {
    const img = await readPixels(png);
    playfieldBlack = countInRect(img, { x0: 70, y0: 60, x1: 210, y1: 315 },
      (r, g, b) => r === 0 && g === 0 && b === 0);
    greenPiece = countInRect(img, { x0: 70, y0: 60, x1: 210, y1: 315 },
      (r, g, b) => g > 180 && r < 40 && b < 80);
    scorePanelFace = countInRect(img, { x0: 212, y0: 124, x1: 362, y1: 253 },
      (r, g, b) => r === 0xC0 && g === 0xC0 && b === 0xC0);
    redPreview = countInRect(img, { x0: 70, y0: 60, x1: 210, y1: 315 },
      (r, g, b) => r > 180 && g < 60 && b < 60);
  }

  const checks = [
    { name: 'bounded run exited cleanly', pass: exitCode === 0 },
    { name: 'real menu click path opened Game menu', pass: /mousedown 44,52/.test(out) && /mouseup 44,52/.test(out) },
    { name: 'real menu click path selected New', pass: /mousedown 56,72/.test(out) && /mouseup 56,72/.test(out) },
    { name: 'New Game PNG written', pass: pngSize > 4000 },
    { name: 'playfield is initialized black', pass: playfieldBlack > 20000 },
    { name: 'score panel remains visible', pass: scorePanelFace > 8000 },
    { name: 'falling brick rendered', pass: greenPiece + redPreview > 100 },
    { name: 'no crash marker', pass: !/STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/.test(out) },
  ];

  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log(`png=${png} size=${pngSize} black=${playfieldBlack} face=${scorePanelFace} green=${greenPiece} red=${redPreview}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
