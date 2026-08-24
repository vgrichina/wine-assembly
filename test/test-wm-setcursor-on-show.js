#!/usr/bin/env node

'use strict';

// A window shown under the cursor must receive WM_SETCURSOR.
//
// On Win98 the pointer is already inside a window the moment it appears, and
// USER asks that window what cursor shape to use. Apps treat the message as
// "we own pixels now" and do real work in it, so a pump that never delivers it
// silently drops whatever that handler was for.
//
// The DX SDK wormhole sample is the sharp case. It draws its tunnel once into
// an 8bpp surface and then animates purely by palette cycling: each vertical
// blank it rotates a 256-entry PALETTEENTRY array and calls SetEntries. The
// array is seeded exactly once, by IDirectDrawPalette::GetEntries -- inside
// its WM_SETCURSOR handler (case 2 of the wndproc jump table at 0x4011a8,
// message 0x20) and nowhere else. Without the message the array stays all
// zeros, the rotation shuffles zeros, and 12000 SetEntries calls later the
// frame is byte-for-byte the one drawn at startup: a perfectly good picture
// that never moves. That is why this test compares two frames rather than
// checking the frame is non-blank -- the broken build passes any is-it-blank
// assertion.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'dx-sdk', 'bin', 'wormhole.exe');
const WASM = path.join(ROOT, 'build', 'wine-assembly.wasm');

if (!fs.existsSync(EXE)) {
  console.log('SKIP: test/binaries/dx-sdk/bin/wormhole.exe not present');
  process.exit(0);
}
if (!fs.existsSync(WASM)) {
  console.log('SKIP: build/wine-assembly.wasm not built');
  process.exit(0);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-setcursor-'));
const early = path.join(outDir, 'early.png');
const late = path.join(outDir, 'late.png');

const result = spawnSync('node', [
  RUN,
  '--app=dx_wormhole',
  '--no-build',
  `--wasm=${WASM}`,
  '--no-close',
  '--max-batches=12000',
  '--repaint-every=100',
  `--input=4000:png:${early},11000:png:${late}`,
], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 32 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const output = `${result.stdout || ''}${result.stderr || ''}`;
if (result.error) throw result.error;
assert.strictEqual(result.status, 0, `CLI exited ${result.status}\n${output.slice(-4000)}`);
assert.ok(fs.existsSync(early) && fs.existsSync(late),
  `captures missing\n${output.slice(-4000)}`);

const a = PNG.sync.read(fs.readFileSync(early));
const b = PNG.sync.read(fs.readFileSync(late));
assert.strictEqual(a.width, b.width);
assert.strictEqual(a.height, b.height);

let lit = 0;
let differ = 0;
for (let i = 0; i < a.data.length; i += 4) {
  if (a.data[i] | a.data[i + 1] | a.data[i + 2]) lit++;
  if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1]
    || a.data[i + 2] !== b.data[i + 2]) differ++;
}
const total = a.width * a.height;

// The tunnel itself: a frame that drew nothing would make the diff assertion
// below meaningless, so establish there is a picture first.
assert.ok(lit / total > 0.05,
  `only ${(lit / total * 100).toFixed(2)}% of the first frame is lit — the tunnel never drew`);

// Palette cycling repaints the whole grid, so the share is large; the floor is
// deliberately far below what a working build produces (~24%) because the
// exact figure depends on where in the cycle each capture lands.
assert.ok(differ / total > 0.02,
  `frames are ${(differ / total * 100).toFixed(4)}% different — the palette animation is frozen, `
  + `which is what a missing WM_SETCURSOR looks like\n${output.slice(-2000)}`);

fs.rmSync(outDir, { recursive: true, force: true });
console.log(`PASS: WM_SETCURSOR reaches a newly shown window `
  + `(wormhole animates, ${(differ / total * 100).toFixed(1)}% of pixels changed)`);
