#!/usr/bin/env node

// Paint's docked child bars share the frame's backing surface. Hiding the
// Color Box makes the frame repaint its client area, but the still-visible
// status bar must be repainted afterward instead of becoming a flat gray strip.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const OUT = path.join(ROOT, 'scratch', 'mspaint-dock-toggle');
const shots = Object.fromEntries(['initial', 'colors-off', 'colors-on']
  .map(name => [name, path.join(OUT, `${name}.png`)]));

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
for (const file of Object.values(shots)) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const input = [
  `14:png:${shots.initial}`,
  '16:0x111:59416',
  `21:png:${shots['colors-off']}`,
  '23:0x111:59416',
  `29:png:${shots['colors-on']}`,
  '30:dump-windows:dock-toggle',
  '31:stop',
].join(',');

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=33',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  runFailed = true;
  output = `${error.stdout || ''}${error.stderr || ''}`;
}

assert(!runFailed, `Paint dock-toggle run failed:\n${output.slice(-3000)}`);
for (const file of Object.values(shots)) {
  assert(fs.existsSync(file) && fs.statSync(file).size > 0, `missing screenshot: ${file}`);
}

const images = Object.fromEntries(Object.entries(shots)
  .map(([name, file]) => [name, PNG.sync.read(fs.readFileSync(file))]));

function statusDifference(a, b) {
  let changed = 0;
  // Paint's initial 269x23 status child occupies this screen rectangle.
  for (let y = 393; y < 416; y++) {
    for (let x = 23; x < 292; x++) {
      const i = (y * a.width + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
          a.data[i + 2] !== b.data[i + 2]) changed++;
    }
  }
  return changed;
}

const hiddenDifference = statusDifference(images.initial, images['colors-off']);
const restoredDifference = statusDifference(images.initial, images['colors-on']);
assert(hiddenDifference <= 10,
  `hiding Color Box overwrote ${hiddenDifference} visible status-bar pixels`);
assert(restoredDifference <= 10,
  `showing Color Box left ${restoredDifference} status-bar pixels overwritten`);
assert(/window:dock-toggle .*class="msctls_statusbar32".*visible=true/.test(output),
  'Paint status child was not visible after Color Box toggle');
assert(!/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output),
  'Paint dock toggle triggered an emulator failure');

console.log(`PASS  Paint Color Box toggle preserves status pixels (${hiddenDifference}/${restoredDifference} changed)`);
