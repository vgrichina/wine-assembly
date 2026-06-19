#!/usr/bin/env node
// Cruel asks for SW_SHOWMAXIMIZED at startup. Its initial deal uses the
// WM_SIZE client dimensions to compute card spacing, so the maximized size
// must arrive before the first client paint creates the Deal button.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'entertainment-pack', 'cruel.exe');
const DLL  = path.join(__dirname, 'binaries', 'entertainment-pack', 'cards.dll');
const TMP  = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });

if (!fs.existsSync(EXE) || !fs.existsSync(DLL)) {
  console.log('SKIP  cruel.exe/cards.dll not found');
  process.exit(0);
}

const pngPath = path.join(TMP, 'cruel_max_launch_layout.png');
try { fs.unlinkSync(pngPath); } catch (_) {}

const inputSpec = [
  '5:0x111:1',
  '120:dump-windows:cruel',
  `140:png:${pngPath}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --dlls="${DLL}" --screen=1024x768 --no-close --input=${inputSpec} --max-batches=220 --batch-size=25000 --quiet-api`;
console.log('$', cmd.replace(ROOT, '.'));

let out = '';
let exitCode = 0;
try {
  out = execSync(cmd, {
    encoding: 'utf-8', timeout: 120000, cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  exitCode = e.status ?? 1;
  console.log(`(run.js exited non-zero status=${exitCode} - output captured)`);
}

function parseWindow(hwnd) {
  const lines = out.split('\n').filter(l => l.includes(`[input] window:cruel hwnd=${hwnd}`));
  const line = lines[lines.length - 1] || '';
  const m = line.match(/pos=(-?\d+),(-?\d+) size=(\d+)x(\d+)/);
  return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4], line } : null;
}

const top = parseWindow(65537);
const deal = parseWindow(65538);
const png = fs.existsSync(pngPath) ? PNG.sync.read(fs.readFileSync(pngPath)) : null;
const checks = [
  { name: 'run.js exited cleanly', pass: exitCode === 0 },
  { name: 'screenshot is 1024x768', pass: !!png && png.width === 1024 && png.height === 768 },
  { name: 'Cruel top-level starts maximized', pass: !!top && top.x === 0 && top.y === 0 && top.w === 1024 && top.h === 768 },
  { name: 'Deal button uses maximized layout', pass: !!deal && deal.x >= 800 && deal.x <= 900 && deal.y === 34 },
];

let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`top: ${top ? top.line : '(missing)'}`);
console.log(`deal: ${deal ? deal.line : '(missing)'}`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
