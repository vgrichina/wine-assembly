#!/usr/bin/env node
'use strict';

// Long local-corpus acceptance for the Windows ScummVM shipped by GOG with
// Lure of the Temptress. The proprietary fixture is gitignored and this test
// is intentionally not part of run-all.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const installed = path.join(root,
  'test/binaries/candidates/gog-free-lure-of-the-temptress/installed');
const scummvm = path.join(installed, 'scummvm', 'scummvm.exe');
const sdl = path.join(installed, 'scummvm', 'sdl2.dll');
const config = path.join(installed, '__support', 'app', 'lure.ini');

if (![scummvm, sdl, config, path.join(installed, 'disk1.vga')].every(fs.existsSync)) {
  console.log('SKIP Lure of the Temptress local installed payload is not present');
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lure-scummvm-'));
const screenshot = path.join(temp, 'lure-revolution.png');
const args = [
  'test/run.js', `--exe=${scummvm}`,
  '--args=-c c:\\lure.ini --path=c:\\ lure',
  '--env=SDL_RENDER_DRIVER=software',
  '--vfs-include=../disk1.vga', '--vfs-include=../disk2.vga',
  '--vfs-include=../disk3.vga', '--vfs-include=../disk4.vga',
  `--vfs-mount=${config}=c:\\lure.ini`, `--dll-seed=${sdl}`,
  '--no-build', '--winver=win2k', '--screen=800x600',
  '--max-batches=250000', '--max-seconds=12', '--quiet-api', '--quiet-blocks',
  `--png=${screenshot}`,
];

try {
  const run = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 90000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${run.stdout || ''}\n${run.stderr || ''}`;
  assert.strictEqual(run.error, undefined, run.error && run.error.message);
  assert.strictEqual(run.status, 0, output.slice(-8000));
  assert(fs.existsSync(screenshot), `ScummVM omitted its final frame\n${output.slice(-8000)}`);
  assert(/\[SetWindowText\] "Lure of the Temptress \(VGA\/DOS\/English\)"/.test(output),
    `ScummVM did not start Lure\n${output.slice(-8000)}`);
  assert(!/EIP=0x00000000/.test(output),
    `ScummVM returned to a null instruction pointer\n${output.slice(-8000)}`);

  const png = PNG.sync.read(fs.readFileSync(screenshot));
  let red = 0;
  let gray = 0;
  const colors = new Set();
  // The software SDL renderer presents a 640x480 frame centered at 80,60.
  // The timed capture may land on Revolution's red/orange mark or ScummVM's
  // orange logo splash; both carry a large warm field plus neutral lettering.
  for (let y = 60; y < 540; y++) {
    for (let x = 80; x < 720; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      colors.add((r << 16) | (g << 8) | b);
      if (r > 35 && r > g * 1.45 && r > b * 1.45) red++;
      if (r > 45 && r < 210 && Math.abs(r - g) < 5 && Math.abs(r - b) < 5) gray++;
    }
  }
  assert(red > 20000 && gray > 1000 && colors.size > 80,
    `Lure splash was not visibly rendered: red=${red}, gray=${gray}, colors=${colors.size}`);
  console.log(`PASS Lure runs in GOG ScummVM inside Wine-Assembly ` +
    `(${red} warm splash pixels, ${gray} neutral logo pixels, ${colors.size} colors)`);
  if (process.env.KEEP_LURE_SCUMMVM_TMP === '1') {
    console.log(`kept Lure artifacts: ${temp}`);
  } else {
    fs.rmSync(temp, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`FAIL Lure ScummVM: ${error.stack || error.message}`);
  console.error(`kept Lure artifacts: ${temp}`);
  process.exit(1);
}
