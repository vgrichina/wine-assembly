#!/usr/bin/env node
'use strict';

// Long local-corpus acceptance for Arena in GOG's bundled Windows DOSBox.
// The proprietary fixture is gitignored and this test is not part of run-all.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const installed = path.join(root,
  'test/binaries/candidates/gog-free-elder-scrolls-arena/installed');
const dosbox = path.join(installed, 'DOSBOX', 'DOSBox.exe');
const waConfig = path.join(root, 'test/configs/arena-wine-assembly.conf');

if (![dosbox, path.join(installed, 'ACD.EXE'), path.join(installed, 'GLOBAL.BSA')]
  .every(fs.existsSync)) {
  console.log('SKIP Arena local installed payload is not present');
  process.exit(0);
}

assert(/^core=dynamic$/m.test(fs.readFileSync(waConfig, 'utf8')),
  'Arena acceptance must exercise DOSBox dynamic core');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-arena-dosbox-'));
const game = path.join(temp, 'arena-game.png');
const args = [
  'test/run.js', `--exe=${dosbox}`,
  '--args=-conf "c:\\arena-wa.conf" -noconsole',
  '--vfs-include=*', '--vfs-include=../**/*',
  `--vfs-mount=${waConfig}=c:\\arena-wa.conf`,
  '--no-build', '--screen=800x600', '--max-batches=2200',
  '--max-seconds=240', '--batch-size=2000000', '--real-ticks',
  '--repaint-every=20', '--stuck-after=1000000', '--quiet-api',
  '--quiet-blocks', '--no-close', `--input=2000:png:${game}`,
];

try {
  const run = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${run.stdout || ''}\n${run.stderr || ''}`;
  assert.strictEqual(run.error, undefined, run.error && run.error.message);
  assert.strictEqual(run.status, 0, output.slice(-8000));
  assert(fs.existsSync(game), `Arena omitted its batch-2000 frame\n${output.slice(-8000)}`);
  assert(!/EIP=0x00000000/.test(output),
    `DOSBox returned to a null instruction pointer\n${output.slice(-8000)}`);
  const titles = [...output.matchAll(/\[SetWindowText\] "([^"]+)"/g)];
  assert(titles.length && /Program:\s+ACD$/.test(titles.at(-1)[1]),
    `DOSBox did not retain ACD as the active program\n${output.slice(-8000)}`);

  const png = PNG.sync.read(fs.readFileSync(game));
  let black = 0;
  let nonblack = 0;
  const colors = new Set();
  // With scaler=none, the 640x400 guest frame occupies x=1..640, y=22..421.
  // The game frame is palette-rich and nearly full-frame; the diagnosed DOS
  // error screens have only 9-10 colors and roughly 133k black pixels.
  for (let y = 22; y < 422; y++) {
    for (let x = 1; x < 641; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      colors.add((r << 16) | (g << 8) | b);
      if (r < 10 && g < 10 && b < 10) black++;
      else nonblack++;
    }
  }
  assert(colors.size >= 50 && nonblack > 250000 && black < 5000,
    `Arena game frame was not visibly rendered: colors=${colors.size}, ` +
    `nonblack=${nonblack}, black=${black}`);
  console.log(`PASS Arena runs inside bundled DOSBox in Wine-Assembly ` +
    `(${colors.size} colors, ${nonblack} nonblack, ${black} black pixels)`);
  if (process.env.KEEP_ARENA_DOSBOX_TMP === '1') {
    console.log(`kept Arena artifacts: ${temp}`);
  } else {
    fs.rmSync(temp, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`FAIL Arena DOSBox: ${error.stack || error.message}`);
  console.error(`kept Arena artifacts: ${temp}`);
  process.exit(1);
}

