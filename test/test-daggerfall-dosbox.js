#!/usr/bin/env node
'use strict';

// Long, local-corpus acceptance for running the DOS Daggerfall payload in the
// GOG-bundled Windows DOSBox, with that Windows DOSBox hosted by Wine-Assembly.
// This is deliberately not in run-all: the proprietary fixture is gitignored
// and nested interpretation takes about three minutes on the development Mac.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const installed = path.join(root,
  'test/binaries/candidates/gog-free-elder-scrolls-daggerfall/installed');
const dosbox = path.join(installed, 'DOSBOX', 'DOSBox.exe');
const gogConfig = path.join(installed, '__support', 'app', 'dosbox_daggerfall.conf');
const waConfig = path.join(root, 'test/configs/daggerfall-wine-assembly.conf');
const launchConfig = path.join(root, 'test/configs/daggerfall-launch.conf');

if (!fs.existsSync(dosbox) || !fs.existsSync(path.join(installed, 'FALL.EXE'))) {
  console.log('SKIP Daggerfall local candidate payload is not present');
  process.exit(0);
}

assert(/^core=dynamic$/m.test(fs.readFileSync(waConfig, 'utf8')),
  'Daggerfall acceptance must exercise DOSBox dynamic core, not mask nested-JIT regressions');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-daggerfall-dosbox-'));
const intro = path.join(temp, 'daggerfall-intro.png');
const args = [
  'test/run.js', `--exe=${dosbox}`,
  '--args=-conf "c:\\dosbox_daggerfall.conf" -conf "c:\\dosbox-wa.conf" -conf "c:\\dosbox-launch.conf" -noconsole',
  '--vfs-include=*', '--vfs-include=../**/*',
  `--vfs-mount=${gogConfig}=c:\\dosbox_daggerfall.conf`,
  `--vfs-mount=${waConfig}=c:\\dosbox-wa.conf`,
  `--vfs-mount=${launchConfig}=c:\\dosbox-launch.conf`,
  '--no-build', '--screen=800x600', '--max-batches=2100',
  '--max-seconds=240', '--batch-size=2000000', '--tick-ms-per-batch=200',
  '--repaint-every=20', '--stuck-after=1000000', '--quiet-api',
  '--quiet-blocks', '--no-close', `--input=2000:png:${intro}`,
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
  assert(fs.existsSync(intro), `Daggerfall omitted its batch-2000 frame\n${output.slice(-8000)}`);
  assert(!/CauseWay error 05|Program:\s+DOSBOX"\s*$/.test(output),
    `Daggerfall returned to DOS instead of remaining active\n${output.slice(-8000)}`);
  const titles = [...output.matchAll(/\[SetWindowText\] "([^"]+)"/g)];
  assert(titles.length && /Program:\s+FALL$/.test(titles.at(-1)[1]),
    `DOSBox did not retain FALL as the active program\n${output.slice(-8000)}`);

  const png = PNG.sync.read(fs.readFileSync(intro));
  let brown = 0;
  const colors = new Set();
  // With scaler=none, the 320x200 guest frame occupies x=1..320, y=22..221.
  // Bethesda's first credit is a dark brown raster on black; DOSBox's prior
  // blue mode and an empty graphics surface do not satisfy this signature.
  for (let y = 22; y < 222; y++) {
    for (let x = 1; x < 321; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      colors.add((r << 16) | (g << 8) | b);
      if (r > 5 && r > g * 1.2 && g >= b) brown++;
    }
  }
  assert(brown > 5000 && colors.size >= 8,
    `Daggerfall intro was not visibly rendered: brown=${brown}, colors=${colors.size}`);
  console.log(`PASS Daggerfall runs inside bundled DOSBox in Wine-Assembly ` +
    `(${brown} Bethesda-credit pixels, ${colors.size} guest-frame colors)`);
  if (process.env.KEEP_DAGGERFALL_DOSBOX_TMP === '1') {
    console.log(`kept Daggerfall artifacts: ${temp}`);
  } else {
    fs.rmSync(temp, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`FAIL Daggerfall DOSBox: ${error.stack || error.message}`);
  console.error(`kept Daggerfall artifacts: ${temp}`);
  process.exit(1);
}
