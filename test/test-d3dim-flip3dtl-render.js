#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'dx-sdk', 'bin', 'flip3dtl.exe');
const WASM = path.join(ROOT, 'build', 'wine-assembly.wasm');

if (!fs.existsSync(EXE) || !fs.existsSync(WASM)) {
  console.log('SKIP: Flip3DTL binary or built WASM is unavailable');
  process.exit(0);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd3dim-flip3dtl-'));
const pngPath = path.join(outDir, 'frame.png');
const result = spawnSync('node', [
  RUN,
  `--exe=${EXE}`,
  '--no-build',
  '--no-close',
  '--quiet-api',
  '--quiet-blocks',
  '--max-batches=50',
  '--batch-size=1000',
  `--png=${pngPath}`,
  '--input=45:stop',
], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 30000,
  maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const output = `${result.stdout || ''}${result.stderr || ''}`;
if (result.error) throw result.error;
assert.strictEqual(result.status, 0, `Flip3DTL exited ${result.status}\n${output.slice(-4000)}`);
assert.ok(fs.existsSync(pngPath), `Flip3DTL produced no frame\n${output.slice(-4000)}`);

const png = PNG.sync.read(fs.readFileSync(pngPath));
let centerPixels = 0;
for (let y = 70; y < Math.min(410, png.height); y++) {
  for (let x = 140; x < Math.min(500, png.width); x++) {
    const off = (y * png.width + x) * 4;
    if (png.data[off] || png.data[off + 1] || png.data[off + 2]) centerPixels++;
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
assert.ok(centerPixels > 1000,
  `Flip3DTL HUD advanced but animated cube was absent (${centerPixels} center pixels)`);
console.log(`PASS  Flip3DTL rasterizes its animated cube (${centerPixels} center pixels)`);
