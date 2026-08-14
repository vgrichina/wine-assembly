#!/usr/bin/env node

'use strict';

// Paint initially creates its MDI view at full frame height, then docks the
// real status bar over the old view scrollbar. The status control must repaint
// that shared surface instead of exposing the stale arrow buttons and thumb.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = process.env.MSPAINT_EXE || path.join(__dirname, 'binaries', 'mspaint.exe');
const SHOT = path.join(ROOT, 'scratch', 'mspaint-statusbar.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

try { fs.unlinkSync(SHOT); } catch (_) {}

let output = '';
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=20:dump-windows:status,20:png:${SHOT},21:stop`,
    '--max-batches=25',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  output = `${error.stdout || ''}${error.stderr || ''}`;
  assert.fail(`Paint status-bar run failed:\n${output.slice(-3000)}`);
}

assert(fs.existsSync(SHOT) && fs.statSync(SHOT).size > 0,
  'Paint status-bar screenshot was not written');
const image = PNG.sync.read(fs.readFileSync(SHOT));
const statusLine = output.split('\n').find(line =>
  line.includes('window:status') && line.includes('class="msctls_statusbar32"')) || '';
assert(statusLine.includes('ctrlClass=0'),
  `Paint status bar must retain its registered guest wndproc: ${statusLine}`);
assert(statusLine.includes('pos=0,332 size=269x23'),
  `Paint status bar did not retain its MFC docked geometry: ${statusLine}`);

// The old stale scrollbar has mirrored black triangular arrows in both 16px
// end boxes. A real status line has prompt glyphs on the left and no arrow in
// the right-side pane before the size grip.
let rightArrowInk = 0;
for (let y = 404; y <= 410; y++) {
  for (let x = 280; x <= 284; x++) {
    const p = (y * image.width + x) * 4;
    if (image.data[p] < 32 && image.data[p + 1] < 32 && image.data[p + 2] < 32) rightArrowInk++;
  }
}

let promptInk = 0;
for (let y = 397; y < 412; y++) {
  for (let x = 27; x < 220; x++) {
    const p = (y * image.width + x) * 4;
    if (image.data[p] < 80 && image.data[p + 1] < 80 && image.data[p + 2] < 80) promptInk++;
  }
}

assert(promptInk >= 30, `Paint status prompt did not render (${promptInk} dark pixels)`);
assert(rightArrowInk < 8,
  `Paint status bar still exposes the stale right scrollbar arrow (${rightArrowInk} pixels)`);
assert(!/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output),
  'Paint status-bar paint triggered an emulator failure');

console.log(`PASS  Paint status bar replaces stale MDI scrollbar pixels (${promptInk} prompt pixels)`);
