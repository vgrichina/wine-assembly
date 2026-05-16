#!/usr/bin/env node
// EmPipe gameplay regression: launch, click the visible Next button, press the
// in-game Accelerate button, and verify the window stays visible on the board.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'wep32-community', 'EmPipe', 'EMPIPE.EXE');
const OUT = path.join(ROOT, 'scratch');
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(EXE)) {
  console.log('SKIP  EmPipe.exe missing');
  process.exit(0);
}

const startedPng = path.join(OUT, 'empipe_after_next.png');
const gameplayPng = path.join(OUT, 'empipe_after_gameplay.png');
for (const p of [startedPng, gameplayPng]) {
  try { fs.unlinkSync(p); } catch (_) {}
}

const inputSpec = [
  '130:mousedown:475:354',
  '132:mouseup:475:354',
  `190:png:${startedPng}`,
  '220:mousedown:475:354',
  '222:mouseup:475:354',
  `700:png:${gameplayPng}`,
  '710:stop',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  '--no-close',
  `--input=${inputSpec}`,
  '--max-batches=730',
  '--trace-api=SetTimer,KillTimer,ShowWindow,DestroyWindow',
  '--quiet-blocks',
  '--dump-backcanvas',
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
  if (/\[input\]|SetTimer|STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED/.test(line)) {
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
  const startedSize = fs.existsSync(startedPng) ? fs.statSync(startedPng).size : 0;
  const gameplaySize = fs.existsSync(gameplayPng) ? fs.statSync(gameplayPng).size : 0;
  let redPlayfield = 0;
  let grayButton = 0;
  let buttonInk = 0;

  if (gameplaySize) {
    const img = await readPixels(gameplayPng);
    redPlayfield = countInRect(img, { x0: 35, y0: 74, x1: 520, y1: 327 },
      (r, g, b) => r > 90 && r < 170 && g < 30 && b < 30);
    grayButton = countInRect(img, { x0: 430, y0: 345, x1: 528, y1: 365 },
      (r, g, b) => r >= 0xb0 && r <= 0xd0 && g >= 0xb0 && g <= 0xd0 && b >= 0xb0 && b <= 0xd0);
    buttonInk = countInRect(img, { x0: 430, y0: 345, x1: 528, y1: 365 },
      (r, g, b) => r < 80 && g < 80 && b < 80);
  }

  const checks = [
    { name: 'bounded run exited cleanly', pass: exitCode === 0 },
    { name: 'Next click was injected', pass: /mousedown 475,354/.test(out) && /mouseup 475,354/.test(out) },
    { name: 'game timer started', pass: /SetTimer\(0x00010001, 0x00000002/.test(out) },
    { name: 'Accelerate gameplay click was injected', pass: /mousedown 475,354 at batch 220/.test(out) && /mouseup 475,354 at batch 222/.test(out) },
    { name: 'started PNG written', pass: startedSize > 6000 },
    { name: 'gameplay PNG written', pass: gameplaySize > 6000 },
    { name: 'main window remains visible after gameplay input', pass: /png .*empipe_after_gameplay\.png[\s\S]*window hwnd=65537 .*visible=true/.test(out) },
    { name: 'playfield grid still rendered after gameplay input', pass: redPlayfield > 50000 },
    { name: 'bottom action button surface was painted', pass: /window hwnd=65543 .*visible=true .*hasBack=true/.test(out) },
    { name: 'bottom action button remains visible after gameplay input', pass: grayButton > 1000 && buttonInk > 50 },
    { name: 'no destroy-window path after start', pass: !/DestroyWindow/.test(out) },
    { name: 'no crash marker', pass: !/STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/.test(out) },
  ];

  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log(`started=${startedPng} size=${startedSize}`);
  console.log(`gameplay=${gameplayPng} size=${gameplaySize} red=${redPlayfield} button=${grayButton} ink=${buttonInk}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
