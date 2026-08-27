#!/usr/bin/env node
'use strict';

// Long local-corpus acceptance for the Windows ScummVM shipped by GOG with
// Beneath a Steel Sky. The proprietary fixture is gitignored and this test is
// intentionally not part of run-all.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const installed = path.join(root,
  'test/binaries/candidates/gog-free-beneath-a-steel-sky/installed');
const scummvm = path.join(installed, 'scummvm', 'scummvm.exe');
const sdl = path.join(installed, 'scummvm', 'SDL2.dll');
const config = path.join(installed, '__support', 'app', 'beneath.ini');

if (![scummvm, sdl, config, path.join(installed, 'sky.dsk')].every(fs.existsSync)) {
  console.log('SKIP Beneath a Steel Sky local installed payload is not present');
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-beneath-scummvm-'));
const screenshot = path.join(temp, 'beneath-virgin.png');
const args = [
  'test/run.js', `--exe=${scummvm}`,
  '--args=-c c:\\beneath.ini --path=c:\\ beneath',
  '--env=SDL_RENDER_DRIVER=software',
  '--vfs-include=../sky.cpt', '--vfs-include=../sky.dnr',
  '--vfs-include=../sky.dsk',
  `--vfs-mount=${config}=c:\\beneath.ini`, `--dll-seed=${sdl}`,
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
  assert(/\[SetWindowText\] "Beneath a Steel Sky \(v0\.0372 cd\)"/.test(output),
    `ScummVM did not start Beneath a Steel Sky\n${output.slice(-8000)}`);
  assert(!/EIP=0x00000000/.test(output),
    `ScummVM returned to a null instruction pointer\n${output.slice(-8000)}`);

  const png = PNG.sync.read(fs.readFileSync(screenshot));
  let red = 0;
  let white = 0;
  let black = 0;
  const colors = new Set();
  // At this deterministic guest-work boundary the 640x400 game surface shows
  // the red/white Virgin Interactive mark on black. Keep the thresholds broad
  // enough for a neighboring splash frame while rejecting an empty SDL window.
  for (let y = 100; y < 500; y++) {
    for (let x = 80; x < 720; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      colors.add((r << 16) | (g << 8) | b);
      if (r > 160 && r > g * 1.8 && r > b * 1.8) red++;
      if (r > 190 && g > 190 && b > 190) white++;
      if (r < 15 && g < 15 && b < 15) black++;
    }
  }
  assert(red > 15000 && white > 5000 && black > 100000 && colors.size > 15,
    `Beneath splash was not visibly rendered: red=${red}, white=${white}, ` +
    `black=${black}, colors=${colors.size}`);
  console.log(`PASS Beneath a Steel Sky runs in GOG ScummVM inside Wine-Assembly ` +
    `(${red} red, ${white} white, ${black} black pixels, ${colors.size} colors)`);
  if (process.env.KEEP_BENEATH_SCUMMVM_TMP === '1') {
    console.log(`kept Beneath artifacts: ${temp}`);
  } else {
    fs.rmSync(temp, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`FAIL Beneath ScummVM: ${error.stack || error.message}`);
  console.error(`kept Beneath artifacts: ${temp}`);
  process.exit(1);
}
