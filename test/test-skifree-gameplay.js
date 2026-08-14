#!/usr/bin/env node
// SkiFree keeps a window DC acquired during WM_CREATE. Starting a game must
// still draw through that DC after ShowWindow makes the main window visible.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCanvas, loadImage } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'entertainment-pack', 'ski32.exe');
const PNG = path.join(os.tmpdir(), `wine-assembly-skifree-gameplay-${process.pid}.png`);

if (!fs.existsSync(EXE)) {
  console.log('SKIP  ski32.exe not found');
  process.exit(0);
}

try { fs.unlinkSync(PNG); } catch (_) {}

const args = [
  RUN,
  `--exe=${EXE}`,
  '--no-close',
  '--screen=640x480',
  '--quiet-api',
  '--quiet-blocks',
  '--input=80:keydown:113,82:keyup:113,300:stop',
  '--max-batches=320',
  '--batch-size=25000',
  `--png=${PNG}`,
];

console.log('$', [process.execPath, ...args].join(' ').replace(ROOT, '.'));
const run = spawnSync(process.execPath, args, {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 32 * 1024 * 1024,
});
const output = `${run.stdout || ''}${run.stderr || ''}`;

async function countGameplayInk() {
  if (!fs.existsSync(PNG) || fs.statSync(PNG).size <= 1000) return 0;
  const image = await loadImage(PNG);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);

  // The title screen leaves this lower playfield almost entirely white. A
  // started game fills it with the skier, trees, rocks, and terrain marks.
  const left = Math.min(83, image.width);
  const top = Math.min(240, image.height);
  const width = Math.max(0, Math.min(474, image.width - left));
  const height = Math.max(0, Math.min(237, image.height - top));
  const pixels = ctx.getImageData(left, top, width, height).data;
  let ink = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] < 245 || pixels[i + 1] < 245 || pixels[i + 2] < 245) ink++;
  }
  return ink;
}

(async () => {
  let gameplayInk = 0;
  try {
    gameplayInk = await countGameplayInk();
  } finally {
    try { fs.unlinkSync(PNG); } catch (_) {}
  }

  const checks = [
    { name: 'CLI run exits cleanly', pass: run.status === 0 && !run.error },
    { name: 'F2 keydown reaches the emulator', pass: /\[input\].*keydown.*(?:vk=)?113\b/.test(output) },
    { name: 'final screenshot is written', pass: gameplayInk > 0 },
    { name: 'F2 starts visible gameplay', pass: gameplayInk >= 1200 },
    { name: 'no runtime crash', pass: !/\*\*\* CRASH|UNIMPLEMENTED API:|LinkError/.test(output) },
  ];

  console.log(`gameplay ink: ${gameplayInk} pixels`);
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
