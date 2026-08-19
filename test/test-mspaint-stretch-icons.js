#!/usr/bin/env node

// Paint's Stretch and Skew dialog uses four SS_ICON controls backed by
// RT_GROUP_ICON resources. Their color planes and transparency masks must be
// painted instead of leaving four blank dialog-face rectangles.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const SHOT = path.join(ROOT, 'scratch', 'mspaint-stretch-icons.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

try { fs.unlinkSync(SHOT); } catch (_) {}

const input = [
  '25:wait-title-command:untitled_-_Paint:70:37681:stretch',
  '38:dlg-dump:stretch',
  `39:png:${SHOT}`,
  '40:stop',
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
    // Ceiling for a hang, not a performance budget — see the note in
    // test-mspaint-scrollbar-thumb.js. At 10s this test went red on a loaded
    // box (18.5s wall) while passing fine when run by hand.
  ], { cwd: ROOT, encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  output = `${error.stdout || ''}${error.stderr || ''}`;
  assert.fail(`Paint Stretch and Skew run failed:\n${output.slice(-4000)}`);
}

assert(fs.existsSync(SHOT) && fs.statSync(SHOT).size > 0,
  'Paint Stretch and Skew screenshot was not written');
assert(/dlg-dump:stretch: dlg=0x[0-9a-f]+/.test(output),
  'Paint Stretch and Skew dialog did not open');

const image = PNG.sync.read(fs.readFileSync(SHOT));
for (const id of [1055, 1056, 1057, 1058]) {
  const match = output.match(new RegExp(
    `id=${id} cls=3[^|]*screen=(-?\\d+),(-?\\d+)[^|]*imageOrd=(\\d+)`));
  assert(match, `Paint icon control ${id} was not reported`);
  const x = Number(match[1]);
  const y = Number(match[2]);
  const ordinal = Number(match[3]);
  let redPixels = 0;
  for (let yy = y; yy < Math.min(y + 35, image.height); yy++) {
    for (let xx = x; xx < Math.min(x + 27, image.width); xx++) {
      if (xx < 0 || yy < 0) continue;
      const p = (yy * image.width + xx) * 4;
      const red = image.data[p];
      const green = image.data[p + 1];
      const blue = image.data[p + 2];
      if (red > 180 && green < 100 && blue < 100) redPixels++;
    }
  }
  assert(redPixels > 20,
    `Paint resource icon ${ordinal} is blank (${redPixels} red illustration pixels)`);
}
assert(!/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output),
  'Paint Stretch and Skew triggered an emulator failure');

console.log('PASS  Paint Stretch and Skew renders all four resource illustrations');
