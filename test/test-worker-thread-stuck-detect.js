#!/usr/bin/env node
'use strict';

// The headless harness gives up on a run whose main thread stops changing.
// Every signal it sampled belonged to the main instance, so an app that parks
// its message loop and draws from a worker thread looked wedged: CITYSCAP.SCR
// creates a render thread, returns to GetMessageA, and was cut off after 11
// batches with a blank screen. Worker EIPs now count as progress.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const SAVER = path.join(ROOT, 'test', 'binaries', 'screensavers', 'CITYSCAP.SCR');
const OPTIONAL_WASM = process.env.WINE_ASSEMBLY_WASM || '';

if (!fs.existsSync(SAVER)) {
  console.log('SKIP  screensaver corpus is not installed');
  process.exit(0);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-stuck-'));
const screenshot = path.join(outDir, 'city.png');
const args = [path.join(ROOT, 'test', 'run.js'), '--app=scr_cityscap',
  '--no-close', '--max-batches=8000', '--quiet-api', '--quiet-blocks',
  `--png=${screenshot}`];
if (OPTIONAL_WASM) args.push('--no-build', `--wasm=${OPTIONAL_WASM}`);

const output = execFileSync(process.execPath, args, {
  cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024,
});

assert.doesNotMatch(output, /STUCK at EIP/,
  'a main thread idling in GetMessageA while a worker renders is not stuck');
assert.doesNotMatch(output, /\*\*\* CRASH|RuntimeError/);
assert.match(output, /\[ThreadManager\] Spawned thread 1/,
  'CITYSCAP should still spawn its render thread');

// The renderer draws the skyline into a DIB section and blits it to the
// window. Before the fix the screen was one flat colour.
const png = PNG.sync.read(fs.readFileSync(screenshot));
const seen = new Set();
for (let i = 0; i < png.data.length; i += 4) {
  seen.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
  if (seen.size > 1) break;
}
assert.ok(seen.size > 1, 'the render thread should have put something on screen');

fs.rmSync(outDir, { recursive: true, force: true });
console.log('PASS test-worker-thread-stuck-detect');
