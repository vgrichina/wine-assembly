#!/usr/bin/env node
// SkiFree keeps a window DC acquired during WM_CREATE. Starting and steering
// a game must keep presenting changing memory-DC sprites through that retained
// DC after ShowWindow makes the main window visible.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCanvas, loadImage } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'entertainment-pack', 'ski32.exe');
const PNG_STILL = path.join(os.tmpdir(), `wine-assembly-skifree-still-${process.pid}.png`);
const PNG_FRAME_A = path.join(os.tmpdir(), `wine-assembly-skifree-frame-a-${process.pid}.png`);
const PNG_FRAME_B = path.join(os.tmpdir(), `wine-assembly-skifree-frame-b-${process.pid}.png`);
const PNGS = [PNG_STILL, PNG_FRAME_A, PNG_FRAME_B];

if (!fs.existsSync(EXE)) {
  console.log('SKIP  ski32.exe not found');
  process.exit(0);
}

for (const png of PNGS) {
  try { fs.unlinkSync(png); } catch (_) {}
}

const args = [
  RUN,
  `--exe=${EXE}`,
  '--no-close',
  '--screen=640x480',
  '--quiet-api',
  '--quiet-blocks',
  `--input=80:keydown:113,82:keyup:113,100:png:${PNG_STILL},` +
    `110:keydown:104,112:png:${PNG_FRAME_A},118:png:${PNG_FRAME_B},120:keyup:104,140:stop`,
  '--max-batches=160',
  '--batch-size=25000',
];

console.log('$', [process.execPath, ...args].join(' ').replace(ROOT, '.'));
const run = spawnSync(process.execPath, args, {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 32 * 1024 * 1024,
});
const output = `${run.stdout || ''}${run.stderr || ''}`;

async function readPixels(png) {
  if (!fs.existsSync(png) || fs.statSync(png).size <= 1000) return null;
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data };
}

function countChangedPixels(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return 0;

  // Ignore desktop and chrome. This is the stable client playfield below the
  // score panel, where the sprite blits move after a numpad direction key.
  const left = 83;
  const top = 75;
  const right = Math.min(557, a.width);
  const bottom = Math.min(476, a.height);
  let changed = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * a.width + x) * 4;
      const delta = Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (delta >= 32) changed++;
    }
  }
  return changed;
}

function countTitleBlue(frame) {
  if (!frame) return 0;
  let blue = 0;
  const right = Math.min(557, frame.width);
  const bottom = Math.min(20, frame.height);
  for (let y = 2; y < bottom; y++) {
    for (let x = 83; x < right; x++) {
      const i = (y * frame.width + x) * 4;
      if (frame.data[i] < 40 && frame.data[i + 1] < 80 && frame.data[i + 2] > 100) blue++;
    }
  }
  return blue;
}

(async () => {
  let still = null;
  let frameA = null;
  let frameB = null;
  try {
    [still, frameA, frameB] = await Promise.all(PNGS.map(readPixels));
  } finally {
    for (const png of PNGS) {
      try { fs.unlinkSync(png); } catch (_) {}
    }
  }

  const startDelta = countChangedPixels(still, frameA);
  const animationDelta = countChangedPixels(frameA, frameB);
  const titleBlueA = countTitleBlue(frameA);
  const titleBlueB = countTitleBlue(frameB);

  const checks = [
    { name: 'CLI run exits cleanly', pass: run.status === 0 && !run.error },
    { name: 'F2 keydown reaches the emulator', pass: /\[input\].*keydown.*(?:vk=)?113\b/.test(output) },
    { name: 'numpad direction reaches the emulator', pass: /\[input\].*keydown.*(?:vk=)?104\b/.test(output) },
    { name: 'all gameplay screenshots are written', pass: !!still && !!frameA && !!frameB },
    { name: 'direction starts visible gameplay', pass: startDelta >= 500 },
    { name: 'successive gameplay frames keep changing', pass: animationDelta >= 100 },
    { name: 'window chrome remains visible', pass: titleBlueA >= 1000 && titleBlueB >= 1000 },
    { name: 'no runtime crash', pass: !/\*\*\* CRASH|UNIMPLEMENTED API:|LinkError/.test(output) },
  ];

  console.log(`client changes: start=${startDelta}, animation=${animationDelta}; title blue=${titleBlueA}/${titleBlueB}`);
  let failed = 0;
  for (const check of checks) {
    console.log(`${check.pass ? 'PASS  ' : 'FAIL  '}${check.name}`);
    if (!check.pass) failed++;
  }
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error.stack || error);
  try { fs.unlinkSync(PNG); } catch (_) {}
  process.exit(1);
});
