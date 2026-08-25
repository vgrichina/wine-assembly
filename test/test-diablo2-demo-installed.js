#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const installed = path.join(root,
  'test/binaries/candidates/diablo-2-demo-installer/installed-extracted');
const exe = path.join(installed, 'diablo ii.exe');
const dataMpq = path.join(installed, 'd2data.mpq');
const musicMpq = path.join(installed, 'd2music.mpq');
if (!fs.existsSync(exe) || !fs.existsSync(dataMpq) || !fs.existsSync(musicMpq)) {
  console.log('SKIP Diablo II Demo installer-produced payload is not present');
  process.exit(0);
}

const digest = file => crypto.createHash('sha256')
  .update(fs.readFileSync(file)).digest('hex');
assert.strictEqual(fs.statSync(exe).size, 2154496);
assert.strictEqual(digest(exe),
  'd0aa0d30b55f8313e04026cca560ef0d178ee76b2ece6c3ccdc1fca4af46b3f1');
assert.strictEqual(fs.statSync(dataMpq).size, 44301122);
assert.strictEqual(digest(dataMpq),
  '82ed65b7f574234a22a36abb4a6d6a1e7f8bebc4746192f39cdb6603ee382d49');
assert.strictEqual(fs.statSync(musicMpq).size, 32743265);
assert.strictEqual(digest(musicMpq),
  '631172d59cc4a8d9b42faade73b194140b6a327811ea556562df9c89f857a694');

const dlls = [
  'd2cmp.dll', 'd2lang.dll', 'd2net.dll', 'd2sound.dll', 'd2win.dll',
  'd2gfx.dll', 'd2ddraw.dll', 'd2direct3d.dll', 'd2gdi.dll', 'd2glide.dll',
  'binkw32.dll', 'smackw32.dll', 'ijl11.dll', 'storm.dll', 'fog.dll',
].map(file => path.join(installed, file)).join(',');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diablo2-demo-installed-'));
const screenshot = path.join(temp, 'menu.png');
const run = spawnSync(process.execPath, [
  'test/run.js',
  `--exe=${exe}`,
  '--no-build',
  '--vfs-include=*',
  `--dll-seed=${dlls}`,
  '--max-batches=10000',
  '--max-seconds=45',
  '--batch-size=200000',
  '--repaint-every=1000',
  '--quiet-api',
  '--quiet-blocks',
  '--no-close',
  `--png=${screenshot}`,
  '--input=1:wait-title:Diablo II:20000,2:keydown:27,3:keyup:27,' +
    '20:keydown:27,21:keyup:27,40:keydown:27,41:keyup:27,' +
    '60:keydown:27,61:keyup:27',
], {
  cwd: root,
  encoding: 'utf8',
  timeout: 70000,
  maxBuffer: 16 * 1024 * 1024,
});
const output = `${run.stdout || ''}\n${run.stderr || ''}`;
assert.strictEqual(run.error, undefined, run.error && run.error.message);
assert.strictEqual(run.status, 0, output.slice(-5000));
assert(output.includes('[input] wait-title: matched "Diablo II"'),
  `the installed game never created its main window\n${output.slice(-5000)}`);
assert(!output.includes('Archive.cpp'),
  `Storm failed to read an installed MPQ member\n${output.slice(-5000)}`);

const png = PNG.sync.read(fs.readFileSync(screenshot));
assert.strictEqual(png.width, 800);
assert.strictEqual(png.height, 600);
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
const warmLogo = countRegion(210, 35, 590, 185,
  (r, g, b) => r > 150 && g > 45 && g < 220 && b < 120);
const greyButton = (r, g, b) => r > 70 && Math.abs(r - g) < 24 && Math.abs(g - b) < 24;
const singlePlayer = countRegion(250, 185, 550, 235, greyButton);
const exitButton = countRegion(250, 525, 550, 585, greyButton);
const sharewareText = countRegion(20, 550, 190, 585,
  (r, g, b) => r > 150 && g > 150 && b > 150);
assert(warmLogo > 2500, `Diablo II flame logo is missing (${warmLogo} warm pixels)`);
assert(singlePlayer > 3500, `Single Player button is missing (${singlePlayer} grey pixels)`);
assert(exitButton > 3500, `Exit Diablo II button is missing (${exitButton} grey pixels)`);
assert(sharewareText > 200, `Shareware version label is missing (${sharewareText} light pixels)`);

console.log('PASS Diablo II installer-produced payload reaches the rendered Shareware v1.04 menu');
