#!/usr/bin/env node

'use strict';

// A D3D IM viewport whose background material carries a texture must clear to
// that picture, not to the material's diffuse colour.
//
// D3DRM turns a scene background *image* into a viewport background material
// whose diffuse stays opaque white and whose D3DMATERIAL.hTexture (+72) holds
// the picture. A Clear that only reads the diffuse therefore paints the entire
// frame white -- which is exactly how the Plus! 98 Organic Art screensavers
// looked: correct geometry floating on a blank white sky, with nothing in the
// API trace to say the backdrop had been dropped.
//
// ROCKROLL.SCN declares `Backdrop=ro_back.GIF`, a sunset gradient that runs
// yellow at the top to near-black at the bottom, so the check below is that the
// top and bottom strips of the frame differ from each other and neither is
// white. A frame drawn from the diffuse alone fails both halves at once.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(ROOT, 'binaries', 'screensavers', 'ROCKROLL.SCR');
const WASM = path.join(ROOT, 'build', 'wine-assembly.wasm');

if (!fs.existsSync(EXE)) {
  console.log('SKIP: binaries/screensavers/ROCKROLL.SCR not present');
  process.exit(0);
}
if (!fs.existsSync(WASM)) {
  console.log('SKIP: build/wine-assembly.wasm not built');
  process.exit(0);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd3dim-bgtex-'));
const shot = path.join(outDir, 'frame.png');

const result = spawnSync('node', [
  RUN,
  '--app=scr_rockroll',
  '--no-build',
  `--wasm=${WASM}`,
  '--no-close',
  '--max-batches=32000',
  '--repaint-every=500',
  `--input=31000:png:${shot}`,
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
assert.ok(fs.existsSync(shot), `capture missing\n${output.slice(-4000)}`);

const png = PNG.sync.read(fs.readFileSync(shot));

function stripMean(y0, y1) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
    }
  }
  return [r / n, g / n, b / n];
}

const top = stripMean(0, 16);
const bottom = stripMean(png.height - 16, png.height);

const white = (c) => c[0] > 240 && c[1] > 240 && c[2] > 240;
assert.ok(!white(top) && !white(bottom),
  `background is white (top ${top.map(Math.round)}, bottom ${bottom.map(Math.round)}) — `
  + `the viewport cleared to the material diffuse instead of its texture`);

// Sunset gradient: the two ends of the backdrop are nothing like each other.
const spread = Math.abs(top[0] - bottom[0]) + Math.abs(top[1] - bottom[1])
  + Math.abs(top[2] - bottom[2]);
assert.ok(spread > 60,
  `top and bottom strips differ by only ${spread.toFixed(1)} — the backdrop gradient is missing`);

fs.rmSync(outDir, { recursive: true, force: true });
console.log('PASS: viewport background texture is cleared to the backdrop image '
  + `(top ${top.map((v) => Math.round(v)).join(',')} vs bottom `
  + `${bottom.map((v) => Math.round(v)).join(',')})`);
