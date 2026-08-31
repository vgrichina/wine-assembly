#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const installed = path.join(root,
  'test/binaries/candidates/diablo-2-demo-installer/installed-extracted');
if (!fs.existsSync(path.join(installed, 'diablo ii.exe'))) {
  console.log('SKIP Diablo II Demo installer-produced payload is not present');
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diablo2-demo-gameplay-'));
const screenshot = path.join(temp, 'rogue-encampment.png');
const input = [
  '1:wait-title:Diablo II:20000',
  '2:keydown:27', '3:keyup:27',
  '7:keydown:27', '8:keyup:27',
  '14:keydown:27', '15:keyup:27',
  '22:keydown:27', '23:keyup:27',
  // The CLI canvas scales these DirectDraw guest coordinates to 640x480.
  '160:mousedown:320:166', '161:mouseup:320:166',
  '170:mousedown:400:207', '171:mouseup:400:207',
  // Diablo II advances class selection on BN_DOUBLECLICKED.
  '240:dblclick:400:275',
  '275:mousedown:405:527', '276:mouseup:405:527',
  // The name widget consumes WM_CHAR, not only key-down notifications.
  '280:keypress:84', '281:keypress:69',
  '282:keypress:83', '283:keypress:84',
  '290:keydown:13', '291:keypress:13', '292:keyup:13',
  `1650:png:${screenshot}`,
].join(',');

const run = spawnSync(process.execPath, [
  'test/run.js',
  '--app=diablo2_demo',
  '--no-build',
  '--batch-size=1000000',
  '--max-batches=1680',
  '--max-seconds=300',
  '--repaint-every=10000',
  '--quiet-api',
  '--quiet-blocks',
  '--no-close',
  `--input=${input}`,
], {
  cwd: root,
  encoding: 'utf8',
  timeout: 220000,
  maxBuffer: 16 * 1024 * 1024,
});
const output = `${run.stdout || ''}\n${run.stderr || ''}`;
assert.strictEqual(run.error, undefined, run.error && run.error.message);
assert.strictEqual(run.status, 0, output.slice(-5000));
assert(!output.includes('UNIMPLEMENTED API: strncmp'), output.slice(-5000));
assert(!output.includes('UNIMPLEMENTED API: _strnicmp'), output.slice(-5000));
assert(!output.includes('*** CRASH'), output.slice(-5000));
assert(fs.existsSync(screenshot),
  `gameplay screenshot was not captured\n${output.slice(-5000)}`);

const png = PNG.sync.read(fs.readFileSync(screenshot));
assert.strictEqual(png.width, 640);
assert.strictEqual(png.height, 480);
const countRegion = (x0, y0, x1, y1, predicate) => {
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      if (predicate(png.data[i], png.data[i + 1], png.data[i + 2])) count++;
    }
  }
  return count;
};

const terrainGreen = countRegion(0, 0, 640, 380,
  (r, g, b) => g > 30 && g > r * 1.08 && g > b * 1.2);
const lifeOrb = countRegion(0, 360, 125, 480,
  (r, g, b) => r > 70 && r > g * 1.5 && r > b * 1.5);
const manaOrb = countRegion(515, 360, 640, 480,
  (r, g, b) => b > 70 && b > r * 1.35 && b > g * 1.35);
const colors = new Set();
for (let i = 0; i < png.data.length; i += 4) {
  colors.add(`${png.data[i] >> 3},${png.data[i + 1] >> 3},${png.data[i + 2] >> 3}`);
}

assert(terrainGreen > 50000,
  `Rogue Encampment terrain is missing (${terrainGreen} green pixels)`);
assert(lifeOrb > 2500, `life orb is missing (${lifeOrb} red pixels)`);
assert(manaOrb > 2000, `mana orb is missing (${manaOrb} blue pixels)`);
assert(colors.size > 100, `gameplay frame has too few colors (${colors.size})`);

console.log('PASS Diablo II Demo creates a Barbarian and renders playable Rogue Encampment gameplay');
