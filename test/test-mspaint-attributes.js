#!/usr/bin/env node

// Paint's resource-backed Image > Attributes dialog must receive the same
// initial non-client paint as a normal top-level window.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const SHOT = path.join(ROOT, 'scratch', 'mspaint-attributes.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

try { fs.unlinkSync(SHOT); } catch (_) {}

const input = [
  '30:wait-title-command:untitled_-_Paint:80:37683:attributes',
  '50:dlg-dump:attributes',
  `52:png:${SHOT}`,
  '53:stop',
].join(',');

let output = '';
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=65',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  output = `${error.stdout || ''}${error.stderr || ''}`;
  assert.fail(`Paint Attributes run failed:\n${output.slice(-4000)}`);
}

assert(fs.existsSync(SHOT) && fs.statSync(SHOT).size > 0,
  'Paint Attributes screenshot was not written');
assert(/dlg-dump:attributes: dlg=0x[0-9a-f]+/.test(output),
  'Paint Attributes dialog did not open');
assert(/text="&Width:"/.test(output) && /text="&Height:"/.test(output),
  'Paint Attributes controls were not created');
assert(!/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output),
  'Paint Attributes triggered an emulator failure');

const image = PNG.sync.read(fs.readFileSync(SHOT));
let activeCaptionPixels = 0;
for (let y = 3; y < Math.min(22, image.height); y++) {
  for (let x = 3; x < Math.min(356, image.width); x++) {
    const p = (y * image.width + x) * 4;
    const r = image.data[p];
    const g = image.data[p + 1];
    const b = image.data[p + 2];
    if (b > 80 && b > r * 1.5 && b > g * 1.25) activeCaptionPixels++;
  }
}
assert(activeCaptionPixels > 1000,
  `Paint Attributes dialog has no active title bar (${activeCaptionPixels} caption pixels)`);

console.log('PASS  Paint Attributes opens with its Win98 dialog frame and controls');
