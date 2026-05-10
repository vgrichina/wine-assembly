#!/usr/bin/env node
// Funtris Options dialog regression.
//
// Game > Options... is selected through the real menu click path. This test
// catches hangs in that browser-facing route and writes the dialog's actual
// GDI back-canvas PNG.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createCanvas, loadImage } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'wep32-community', 'Funpack', 'Funtris.exe');
const OUT = path.join(ROOT, 'scratch');
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(EXE)) {
  console.log('SKIP  Funtris.exe missing');
  process.exit(0);
}

const optionsPng = path.join(OUT, 'funtris_options.png');
try { fs.unlinkSync(optionsPng); } catch (_) {}

const inputSpec = [
  '3800:mousedown:44:52',
  '3801:mouseup:44:52',
  '3810:mousedown:66:92',
  '3811:mouseup:66:92',
  '3820:wait-title:Options:5000',
  '3860:dlg-paint',
  '3861:dlg-dump:funtris-options',
  `3862:dlg-png:${optionsPng}`,
  '3863:stop',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  '--no-close',
  `--input=${inputSpec}`,
  '--max-batches=3870',
  '--batch-size=100',
  '--stuck-after=100',
  '--quiet-api',
  '--quiet-blocks',
];

console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));

let out = '';
let exitCode = 0;
let timedOut = false;
try {
  out = execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  exitCode = e.status ?? 1;
  timedOut = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
  console.log(`(run.js exited non-zero status=${exitCode}${timedOut ? ' timeout' : ''} - output captured)`);
}

for (const line of out.split('\n')) {
  if (/\[input\]|STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED/.test(line)) {
    console.log('  ' + line);
  }
}

const sizeOf = p => fs.existsSync(p) ? fs.statSync(p).size : 0;
const optionsSize = sizeOf(optionsPng);
const dumpLine = out.split('\n').find(l => l.includes('dlg-dump:funtris-options:')) || '';

async function countBrickColorPixels(pngPath) {
  if (!fs.existsSync(pngPath)) return 0;
  const img = await loadImage(pngPath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  let count = 0;
  for (let y = 225; y < 355 && y < img.height; y++) {
    for (let x = 35; x < 385 && x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if ((r > 120 && g < 110 && b < 110) ||
          (g > 120 && r < 110 && b < 110) ||
          (b > 120 && r < 110 && g < 110)) {
        count++;
      }
    }
  }
  return count;
}

(async () => {
  const brickColorPixels = await countBrickColorPixels(optionsPng);

  const checks = [
    { name: 'bounded run reached Options before timeout', pass: /wait-title: matched "Options"/.test(out) },
    { name: 'Options title appeared', pass: /wait-title: matched "Options"/.test(out) },
    { name: 'Options dialog controls dumped', pass: /text="OK"/.test(dumpLine) && /text="Cancel"/.test(dumpLine) && /text="Defaults"/.test(dumpLine) },
    { name: 'Options dialog labels dumped', pass: /text="Columns"/.test(dumpLine) && /text="Level Time"/.test(dumpLine) && /text="Bricks"/.test(dumpLine) },
    { name: 'Slider controls are native trackbars', pass: /id=1003 cls=19/.test(dumpLine) && /id=1008 cls=19/.test(dumpLine) },
    { name: 'Options GDI PNG written', pass: /dlg-png .*funtris_options\.png/.test(out) && optionsSize > 1000 },
    { name: 'Bricks bitmap previews rendered', pass: brickColorPixels > 250 },
    { name: 'no crash marker', pass: !/STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/.test(out) },
  ];

  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log(`optionsPng=${optionsPng} size=${optionsSize} brickColorPixels=${brickColorPixels}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error(e && e.stack || e);
  process.exit(1);
});
