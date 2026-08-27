#!/usr/bin/env node
'use strict';

// Long local-corpus acceptance for Ultima IV in GOG's bundled Windows DOSBox.
// The proprietary fixture is gitignored and this test is not part of run-all.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const installed = path.join(root,
  'test/binaries/candidates/gog-free-ultima-iv/installed');
const dosbox = path.join(installed, 'DOSBOX', 'DOSBox.exe');
const waConfig = path.join(root, 'test/configs/ultima4-wine-assembly.conf');

if (![dosbox, path.join(installed, 'ULTIMA.COM'), path.join(installed, 'TITLE.EXE')]
  .every(fs.existsSync)) {
  console.log('SKIP Ultima IV local installed payload is not present');
  process.exit(0);
}

const config = fs.readFileSync(waConfig, 'utf8');
assert(/^core=dynamic$/m.test(config),
  'Ultima IV acceptance must exercise DOSBox dynamic core');
assert(/^cycles=fixed 3000$/m.test(config),
  'Ultima IV acceptance depends on its bounded nested-cycle rate');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ultima4-dosbox-'));
const title = path.join(temp, 'ultima4-title.png');
const args = [
  'test/run.js', `--exe=${dosbox}`,
  '--args=-conf "c:\\ultima4-wa.conf" -noconsole',
  '--vfs-include=*', '--vfs-include=../**/*',
  `--vfs-mount=${waConfig}=c:\\ultima4-wa.conf`,
  '--no-build', '--screen=800x600', '--max-batches=1000000',
  '--max-seconds=30', '--batch-size=2000000', '--real-ticks',
  '--repaint-every=20', '--stuck-after=1000000', '--quiet-api',
  '--quiet-blocks', '--no-close', `--png=${title}`,
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
  assert(fs.existsSync(title),
    `Ultima IV omitted its final title frame\n${output.slice(-8000)}`);
  assert(!/EIP=0x00000000/.test(output),
    `DOSBox returned to a null instruction pointer\n${output.slice(-8000)}`);
  const titles = [...output.matchAll(/\[SetWindowText\] "([^"]+)"/g)];
  assert(titles.some(match => /Program:\s+ULTIMA$/.test(match[1])) &&
    titles.some(match => /Program:\s+TITLE$/.test(match[1])),
  `DOSBox did not hand ULTIMA.COM to TITLE.EXE\n${output.slice(-8000)}`);

  const png = PNG.sync.read(fs.readFileSync(title));
  let black = 0;
  let cyan = 0;
  const colors = new Set();
  // scaler=none makes Ultima's 320x200 content occupy x=1..320, y=22..221.
  // The accepted title/map intro is black-backed and palette-rich, with cyan
  // lettering; the earlier orange DOSBox splash cannot satisfy this shape.
  for (let y = 22; y < 222; y++) {
    for (let x = 1; x < 321; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      colors.add((r << 16) | (g << 8) | b);
      if (r < 10 && g < 10 && b < 10) black++;
      if (r < 140 && g > 180 && b > 180) cyan++;
    }
  }
  assert(colors.size >= 10 && black > 40000 && cyan > 1000,
    `Ultima IV title was not visibly rendered: colors=${colors.size}, ` +
    `black=${black}, cyan=${cyan}`);
  console.log(`PASS Ultima IV runs inside bundled DOSBox in Wine-Assembly ` +
    `(${colors.size} colors, ${black} black, ${cyan} cyan pixels)`);
  if (process.env.KEEP_ULTIMA4_DOSBOX_TMP === '1') {
    console.log(`kept Ultima IV artifacts: ${temp}`);
  } else {
    fs.rmSync(temp, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`FAIL Ultima IV DOSBox: ${error.stack || error.message}`);
  console.error(`kept Ultima IV artifacts: ${temp}`);
  process.exit(1);
}
