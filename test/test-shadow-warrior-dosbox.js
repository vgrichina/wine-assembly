#!/usr/bin/env node
'use strict';

// Long local-corpus acceptance for the DOS Shadow Warrior payload in GOG's
// bundled Windows DOSBox. The proprietary fixture is gitignored and this test
// is deliberately not part of run-all.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const installed = path.join(root,
  'test/binaries/candidates/gog-free-shadow-warrior-classic/installed/app');
const dosbox = path.join(installed, 'DOSBOX', 'DOSBox.exe');
const gogConfig = path.join(installed, 'dosbox_swarrior.conf');
const waConfig = path.join(root, 'test/configs/shadow-warrior-wine-assembly.conf');

if (![dosbox, gogConfig, path.join(installed, 'SW.DAT')].every(fs.existsSync)) {
  console.log('SKIP Shadow Warrior local installed payload is not present');
  process.exit(0);
}

assert(/^core=dynamic$/m.test(fs.readFileSync(waConfig, 'utf8')),
  'Shadow Warrior acceptance must exercise DOSBox dynamic core');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-shadow-warrior-dosbox-'));
const startup = path.join(temp, 'shadow-warrior-startup.png');
const args = [
  'test/run.js', `--exe=${dosbox}`,
  '--args=-conf "c:\\dosbox_swarrior.conf" -conf "c:\\dosbox-wa.conf" -noconsole',
  '--vfs-include=*', '--vfs-include=../**/*',
  `--vfs-mount=${gogConfig}=c:\\dosbox_swarrior.conf`,
  `--vfs-mount=${waConfig}=c:\\dosbox-wa.conf`,
  '--no-build', '--screen=800x600', '--max-batches=10000',
  '--max-seconds=360', '--batch-size=5000000', '--real-ticks',
  '--repaint-every=20', '--stuck-after=1000000', '--quiet-api',
  '--quiet-blocks', '--no-close', `--png=${startup}`,
];

try {
  const run = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 420000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${run.stdout || ''}\n${run.stderr || ''}`;
  const reachedHardBound = run.error && run.error.code === 'ETIMEDOUT';
  assert(!run.error || reachedHardBound, run.error && run.error.message);
  if (!reachedHardBound) assert.strictEqual(run.status, 0, output.slice(-8000));
  assert(fs.existsSync(startup), `DOSBox omitted its final frame\n${output.slice(-8000)}`);
  assert(!/EIP=0x00000000/.test(output),
    `DOSBox returned to a null instruction pointer\n${output.slice(-8000)}`);
  const titles = [...output.matchAll(/\[SetWindowText\] "([^"]+)"/g)];
  assert(titles.length && /Program:\s+SW$/.test(titles.at(-1)[1]),
    `DOSBox did not retain SW as the active program\n${output.slice(-8000)}`);

  const png = PNG.sync.read(fs.readFileSync(startup));
  let green = 0;
  let white = 0;
  let black = 0;
  const colors = new Set();
  // With scaler=none, the 640x400 DOS surface occupies x=1..640, y=22..421.
  // SW 1.2's startup console has a broad green title banner, white status copy,
  // and a black body. The prior DOSBox shell and DOS/4GW banner do not satisfy
  // this combined signature.
  for (let y = 22; y < 422; y++) {
    for (let x = 1; x < 641; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      colors.add((r << 16) | (g << 8) | b);
      if (g > 130 && g > r * 1.8 && g > b * 1.3) green++;
      if (r > 150 && g > 150 && b > 150) white++;
      if (r < 15 && g < 15 && b < 15) black++;
    }
  }
  const startupSignature = green > 15000 && white > 2500 &&
    black > 200000 && colors.size >= 5;
  const graphicsSignature = colors.size > 20;
  assert(startupSignature || graphicsSignature,
    `Shadow Warrior startup was not visibly rendered: green=${green}, ` +
    `white=${white}, black=${black}, colors=${colors.size}`);
  console.log(`PASS Shadow Warrior starts in GOG DOSBox inside Wine-Assembly ` +
    `(${green} green, ${white} white, ${black} black pixels, ` +
    `${colors.size} colors)`);
  if (process.env.KEEP_SHADOW_WARRIOR_DOSBOX_TMP === '1') {
    console.log(`kept Shadow Warrior artifacts: ${temp}`);
  } else {
    fs.rmSync(temp, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`FAIL Shadow Warrior DOSBox: ${error.stack || error.message}`);
  console.error(`kept Shadow Warrior artifacts: ${temp}`);
  process.exit(1);
}
