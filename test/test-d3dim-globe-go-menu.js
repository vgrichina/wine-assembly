#!/usr/bin/env node

'use strict';

// Globe assigns command 28 to File -> Go. Menu command IDs belong to the
// application; treating 28 as a USER32-wide Exit shortcut closed this demo
// only when a person clicked the menu (direct WM_COMMAND injection worked).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const before = path.join(os.tmpdir(), `d3dim-globe-before-${process.pid}.png`);
const after = path.join(os.tmpdir(), `d3dim-globe-after-${process.pid}.png`);
const later = path.join(os.tmpdir(), `d3dim-globe-later-${process.pid}.png`);
const latest = path.join(os.tmpdir(), `d3dim-globe-latest-${process.pid}.png`);

function changedPixels(a, b) {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2]) changed++;
  }
  return changed;
}

let out = '';
try {
  out = execFileSync('node', [
    path.join(__dirname, 'run.js'),
    '--app=dx_globe',
    '--batch-size=100000',
    '--max-batches=124',
    '--quiet-api',
    '--no-build',
    `--input=94:png:${before},95:click:40:51,96:mousemove:100:132,`
      + `97:menu-dump:hover,98:click:100:132,104:png:${after},`
      + `112:png:${later},120:png:${latest},121:dump-windows:after,122:stop`,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });

  assert(/menu-dump:hover:.*hover=3.*#3 id=28[^\n]*"&Go"/.test(out),
    'the real pointer path did not hover File -> Go');
  assert(/window:after .*title="Globe Direct3DRM Example"/.test(out),
    'Globe closed after clicking File -> Go');
  assert(!/\[Exit\]/.test(out), 'File -> Go was routed to Exit');

  const a = PNG.sync.read(fs.readFileSync(before));
  const b = PNG.sync.read(fs.readFileSync(after));
  const c = PNG.sync.read(fs.readFileSync(later));
  const d = PNG.sync.read(fs.readFileSync(latest));
  assert.strictEqual(`${b.width}x${b.height}`, `${a.width}x${a.height}`);
  const deltas = [changedPixels(a, b), changedPixels(b, c), changedPixels(c, d)];
  assert(deltas.every(n => n > 1000),
    `Go did not keep presenting animated frames (${deltas.join(', ')} changed pixels)`);
  console.log(`PASS Globe File -> Go stays open and keeps animating (${deltas.join(', ')} changed pixels)`);
} finally {
  for (const file of [before, after, later, latest]) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}
