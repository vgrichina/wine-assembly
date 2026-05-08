#!/usr/bin/env node
// Calculator regression: dragging the title bar must not desynchronize the
// renderer window rect from WAT's non-client/client geometry. The bug hung the
// next guest run slice after WM_MOUSEMOVE, before the mouse-up or close click.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'calc.exe');
const DLL = path.join(__dirname, 'binaries', 'dlls', 'msvcrt.dll');
const OUT = path.join(ROOT, 'scratch');
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(EXE)) {
  console.log('SKIP  calc.exe missing');
  process.exit(0);
}

const inputSpec = [
  '90:mousedown:90:12',
  '92:mousemove:130:50',
  '94:mouseup:130:50',
  `100:png:${path.join(OUT, 'calc_drag_after_move.png')}`,
  '110:click:329:50',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--dlls=${DLL}`,
  `--input=${inputSpec}`,
  '--max-batches=170',
  '--batch-size=10000',
  '--trace-api=PostQuitMessage,DestroyWindow',
  '--quiet-api',
];

console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));

let out = '';
let failed = false;
try {
  out = execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  failed = true;
  if (e.killed || e.signal === 'SIGTERM') {
    console.log('FAIL  run timed out after drag');
  } else {
    console.log(`FAIL  run exited non-zero status=${e.status ?? 'unknown'}`);
  }
}

function calcControlsStillPainted() {
  const pngPath = path.join(OUT, 'calc_drag_after_move.png');
  if (!fs.existsSync(pngPath)) return false;
  const img = PNG.sync.read(fs.readFileSync(pngPath));
  let nonFace = 0;
  let coloredText = 0;
  // After the drag above, the calc window is at (80,40). This rectangle is
  // inside the standard calc client, excluding most flat COLOR_BTNFACE.
  for (let y = 120; y < 285 && y < img.height; y++) {
    for (let x = 90; x < 330 && x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const face = Math.abs(r - 192) <= 2 && Math.abs(g - 192) <= 2 && Math.abs(b - 192) <= 2;
      if (!face) nonFace++;
      if ((r > 150 && g < 100 && b < 100) || (b > 150 && r < 120)) coloredText++;
    }
  }
  return nonFace > 5000 && coloredText > 200;
}

const checks = [
  { name: 'drag mousemove processed', pass: /\[input\] mousemove 130,50/.test(out) },
  { name: 'drag mouseup processed', pass: /\[input\] mouseup 130,50/.test(out) },
  { name: 'calc controls still painted after drag', pass: calcControlsStillPainted() },
  { name: 'close click processed', pass: /\[input\] click 329,50/.test(out) },
  { name: 'calculator posted quit', pass: /PostQuitMessage/.test(out) },
  { name: 'process exited cleanly', pass: /\[Exit\] code=0/.test(out) && !failed },
];

let failures = failed ? 1 : 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failures++;
}

process.exit(failures ? 1 : 0);
