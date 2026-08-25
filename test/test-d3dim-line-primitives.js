#!/usr/bin/env node

'use strict';

// D3D immediate-mode LINELIST/LINESTRIP must actually rasterize.
//
// $d3dim_draw_primitive implemented POINTLIST plus the three triangle types,
// and $d3dim_draw_indexed_primitive only the triangles. Every other
// D3DPRIMITIVETYPE fell out the bottom of the if-chain having drawn nothing.
// The DX SDK boids.exe draws its whole flock and its wireframe cage as indexed
// LINESTRIPs, so all ~7500 of its draw calls per run were discarded: the
// primary surface ended up fully written (nonZero=1850/1850) but holding a
// single colour, because the only thing that ever touched it was the viewport
// clear.
//
// "Fully written but one colour" is exactly why this test asserts on the
// colour count rather than on nonZero -- the pre-fix frame passes any
// did-anything-touch-the-surface check.
//
// The second half of the fix is the near-plane clip. rhw is 1/w, so a vertex
// at or behind the eye plane projects to a screen coordinate unrelated to
// where the segment goes, and a nonsense endpoint still draws a perfectly good
// line: without the clip, boids' first frame is red and blue streaks spanning
// the entire 640x480 image. That shows up here as a colour count too, since
// the streaks paint far more of the frame than the real geometry does.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'dx-sdk', 'bin', 'boids.exe');
const WASM = path.join(ROOT, 'build', 'wine-assembly.wasm');

if (!fs.existsSync(EXE)) {
  console.log('SKIP: test/binaries/dx-sdk/bin/boids.exe not present');
  process.exit(0);
}
if (!fs.existsSync(WASM)) {
  console.log('SKIP: build/wine-assembly.wasm not built');
  process.exit(0);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd3dim-lines-'));
const png = path.join(outDir, 'boids.png');

// 9000 batches is past the app's DirectDraw setup and texture load; boids is
// drawing its flock well before then. Sampling earlier reports a blank frame
// for reasons that have nothing to do with this rasterizer.
const result = spawnSync('node', [
  RUN,
  '--app=dx_boids',
  '--no-build',
  `--wasm=${WASM}`,
  '--no-close',
  '--max-batches=9000',
  '--dx-surfaces',
  `--input=8000:png:${png}`,
], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 180000,
  maxBuffer: 32 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const output = `${result.stdout || ''}${result.stderr || ''}`;
if (result.error) throw result.error;
assert.strictEqual(result.status, 0, `CLI exited ${result.status}\n${output.slice(-4000)}`);

assert.ok(fs.existsSync(png), `no capture written\n${output.slice(-4000)}`);
const img = PNG.sync.read(fs.readFileSync(png));

// Count against the modal colour, not against black: boids clears to a dark
// navy, so a "non-black pixel" tally calls 98.7% of a perfectly good frame
// lit and measures nothing. The modal colour IS the cleared background, and
// what covers the rest of it is the geometry.
const seen = new Map();
for (let i = 0; i < img.data.length; i += 4) {
  const c = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
  seen.set(c, (seen.get(c) || 0) + 1);
}
let modal = 0;
for (const n of seen.values()) if (n > modal) modal = n;
const drawn = img.width * img.height - modal;

// Before the fix this frame was a single flat colour. Four distinct colours is
// a floor, not a target: the fixed frame carries the cage, the flock and the
// clear colour, and the count drifts with where the birds happen to be.
assert.ok(seen.size >= 4,
  `primary holds ${seen.size} distinct colour(s) — line primitives drew nothing\n${output.slice(-4000)}`);

// Some of the background must survive: a frame where geometry covers nearly
// everything is the unclipped-streak failure, not a flock.
const drawnShare = drawn / (img.width * img.height);
assert.ok(drawnShare > 0.0005,
  `only ${(drawnShare * 100).toFixed(3)}% of the frame differs from the clear colour`);
assert.ok(drawnShare < 0.25,
  `${(drawnShare * 100).toFixed(1)}% of the frame is geometry — near-plane clip is not holding`);

// The surface census is the other half of the story: it is what distinguishes
// "drew nothing" from "drew nothing visible".
const primary = output.split('\n').find(l => l.includes('slot=') && l.includes('flags=0x1'));
assert.ok(primary, `no primary surface in the --dx-surfaces census\n${output.slice(-4000)}`);
const colors = /colors=(\d+)/.exec(primary);
assert.ok(colors && Number(colors[1]) > 1,
  `primary census still reports a single colour: ${primary.trim()}`);

fs.rmSync(outDir, { recursive: true, force: true });
console.log(`PASS: D3DIM line primitives rasterize (${seen.size} colours, ${(drawnShare * 100).toFixed(2)}% geometry)`);
