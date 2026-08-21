#!/usr/bin/env node
'use strict';

// A normal rectangular-selection drag in Paint is a move. The source pixels
// must be erased with the background color; holding Ctrl is the copy gesture.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.resolve(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');
const EXE = path.join(ROOT, 'test', 'binaries', 'mspaint.exe');
const SHOT = path.join(ROOT, 'scratch', 'mspaint-selection-move.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(path.dirname(SHOT), { recursive: true });
try { fs.unlinkSync(SHOT); } catch (_) {}

const input = [
  '18:click:91:375',       // red foreground
  '20:click:39:221',       // Rectangle tool
  '23:mousedown:105:90',
  '24:mousemove:145:130',
  '25:mouseup:145:130',
  '28:click:64:71',        // Rectangular Select tool
  '31:mousedown:98:83',
  '32:mousemove:152:137',
  '33:mouseup:152:137',
  '36:mousedown:120:105',
  '37:mousemove:165:155',
  '38:mouseup:165:155',
  '42:click:260:280',      // commit the moved selection
  `45:png:${SHOT}`,
  '46:stop',
].join(',');

let output = '';
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=50',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
} catch (error) {
  output = `${error.stdout || ''}${error.stderr || ''}`;
  assert.fail(`Paint selection-move run failed:\n${output.slice(-4000)}`);
}

async function main() {
  assert(fs.existsSync(SHOT) && fs.statSync(SHOT).size > 0,
    'Paint did not write the selection-move screenshot');
  const image = await loadImage(SHOT);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height).data;

  const isRed = (x, y) => {
    const i = (y * image.width + x) * 4;
    return pixels[i] > 180 && pixels[i + 1] < 80 && pixels[i + 2] < 80;
  };
  let sourceRed = 0;
  let destinationRed = 0;
  for (let y = 89; y <= 131; y++) {
    for (let x = 104; x <= 146; x++) sourceRed += isRed(x, y) ? 1 : 0;
  }
  for (let y = 139; y <= 181; y++) {
    for (let x = 149; x <= 191; x++) destinationRed += isRed(x, y) ? 1 : 0;
  }

  assert(destinationRed >= 150,
    `Paint lost the moved rectangle (${destinationRed} red destination pixels)`);
  assert.strictEqual(sourceRed, 0,
    `Paint copied instead of moving the selection (${sourceRed} red source pixels remain)`);
  assert(!/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output),
    'Paint selection move triggered an emulator failure');
  console.log('PASS  Paint rectangular selection drag clears its source pixels');
  console.log(`Screenshot: ${SHOT}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
