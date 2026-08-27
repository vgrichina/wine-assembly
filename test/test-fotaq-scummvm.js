#!/usr/bin/env node
'use strict';

// Long local-corpus acceptance for the Windows ScummVM shipped by GOG with
// Flight of the Amazon Queen. The proprietary fixture is gitignored and this
// test is intentionally not part of run-all.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const installed = path.join(root,
  'test/binaries/candidates/gog-free-flight-of-the-amazon-queen/installed');
const scummvm = path.join(installed, 'scummvm', 'scummvm.exe');
const sdl = path.join(installed, 'scummvm', 'SDL2.dll');
const config = path.join(installed, '__support', 'app', 'queen.ini');
const gameData = path.join(installed, 'queen.1');

if (![scummvm, sdl, config, gameData].every(fs.existsSync)) {
  console.log('SKIP Flight of the Amazon Queen local installed payload is not present');
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-fotaq-scummvm-'));
const screenshot = path.join(temp, 'fotaq-title.png');
const args = [
  'test/run.js', `--exe=${scummvm}`,
  '--args=-c c:\\queen.ini --path=c:\\ queen',
  '--env=SDL_RENDER_DRIVER=software',
  '--vfs-include=../queen.1',
  `--vfs-mount=${config}=c:\\queen.ini`, `--dll-seed=${sdl}`,
  '--no-build', '--winver=win2k', '--screen=800x600', '--batch-size=5000',
  '--max-batches=3200', '--max-seconds=90', '--quiet-api', '--quiet-blocks',
  `--png=${screenshot}`,
];

try {
  const run = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${run.stdout || ''}\n${run.stderr || ''}`;
  assert.strictEqual(run.error, undefined, run.error && run.error.message);
  assert.strictEqual(run.status, 0, output.slice(-8000));
  assert(fs.existsSync(screenshot), `ScummVM omitted its final frame\n${output.slice(-8000)}`);
  assert(/\[SetWindowText\] "Flight of the Amazon Queen \(Talkie\/DOS\/English\)"/.test(output),
    `ScummVM did not start Flight of the Amazon Queen\n${output.slice(-8000)}`);
  assert(!/EIP=0x00000000/.test(output),
    `ScummVM returned to a null instruction pointer\n${output.slice(-8000)}`);

  const png = PNG.sync.read(fs.readFileSync(screenshot));
  let gold = 0;
  let cyan = 0;
  let black = 0;
  let navy = 0;
  const colors = new Set();
  // At this deterministic guest-work boundary the 640x400 surface shows the
  // gold Amazon Queen logo and cyan copyright copy over black/navy artwork.
  // The combination rejects both a blank SDL surface and the teal desktop.
  for (let y = 100; y <= 500; y++) {
    for (let x = 80; x <= 720; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      colors.add((r << 16) | (g << 8) | b);
      if (r > 120 && g > 50 && g < 200 && b < 90 && r > g * 1.3) gold++;
      if (r < 100 && g > 80 && b > 100 && b > r * 1.6) cyan++;
      if (r < 15 && g < 15 && b < 15) black++;
      if (r < 50 && g < 60 && b > r * 1.2) navy++;
    }
  }
  assert(gold > 8000 && cyan > 5000 && black > 80000 && navy > 15000 &&
    colors.size > 25,
  `FOTAQ title was not visibly rendered: gold=${gold}, cyan=${cyan}, ` +
    `black=${black}, navy=${navy}, colors=${colors.size}`);
  console.log(`PASS Flight of the Amazon Queen runs in GOG ScummVM inside ` +
    `Wine-Assembly (${gold} gold, ${cyan} cyan, ${black} black, ` +
    `${navy} navy pixels, ${colors.size} colors)`);
  if (process.env.KEEP_FOTAQ_SCUMMVM_TMP === '1') {
    console.log(`kept FOTAQ artifacts: ${temp}`);
  } else {
    fs.rmSync(temp, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`FAIL FOTAQ ScummVM: ${error.stack || error.message}`);
  console.error(`kept FOTAQ artifacts: ${temp}`);
  process.exit(1);
}
