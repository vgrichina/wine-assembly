#!/usr/bin/env node
// Spider starts via SW_SHOWMAXIMIZED. Browser viewport/fullscreen changes
// resize the backing canvas after launch; the maximized HWND must receive
// a real SIZE_MAXIMIZED path so the game repaints its client instead of
// leaving a grey newly allocated surface.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'plus98', 'SPIDER.EXE');
const DLL  = path.join(__dirname, 'binaries', 'entertainment-pack', 'cards.dll');
const TMP  = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });

if (!fs.existsSync(EXE) || !fs.existsSync(DLL)) {
  console.log('SKIP  Spider.exe/cards.dll not found');
  process.exit(0);
}

const beforePng = path.join(TMP, 'spider_max_resize_before.png');
const afterPng = path.join(TMP, 'spider_max_resize_after.png');
for (const p of [beforePng, afterPng]) { try { fs.unlinkSync(p); } catch (_) {} }

const inputSpec = [
  `200:png:${beforePng}`,
  '230:canvas-resize:1024:768',
  `420:png:${afterPng}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --dlls="${DLL}" --no-close --dump-backcanvas --input=${inputSpec} --max-batches=520 --batch-size=50000 --quiet-api`;
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

function parseLastRect() {
  const lines = out.split('\n').filter(l => l.includes('[input] window hwnd=65537'));
  const line = lines[lines.length - 1] || '';
  const m = line.match(/pos=(-?\d+),(-?\d+) size=(\d+)x(\d+)/);
  return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null;
}

function countFeltPixels(pngPath, rect) {
  if (!fs.existsSync(pngPath)) return 0;
  const img = PNG.sync.read(fs.readFileSync(pngPath));
  let count = 0;
  for (let y = rect.y0; y < Math.min(rect.y1, img.height); y++) {
    for (let x = rect.x0; x < Math.min(rect.x1, img.width); x++) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      if (g >= 80 && r <= 40 && b <= 80) count++;
    }
  }
  return count;
}

const afterSize = fs.existsSync(afterPng) ? PNG.sync.read(fs.readFileSync(afterPng)) : null;
const lastRect = parseLastRect();
const lowerRightFelt = countFeltPixels(afterPng, { x0: 760, y0: 540, x1: 1000, y1: 730 });
const checks = [
  { name: 'run.js exited cleanly', pass: exitCode === 0 },
  { name: 'after screenshot is resized backing canvas', pass: !!afterSize && afterSize.width === 1024 && afterSize.height === 768 },
  { name: 'Spider top-level stays maximized to new canvas', pass: !!lastRect && lastRect.x === 0 && lastRect.y === 0 && lastRect.w === 1024 && lastRect.h === 768 },
  { name: 'Spider repainted client after resize', pass: lowerRightFelt > 10000 },
];

let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`last rect: ${JSON.stringify(lastRect)}`);
console.log(`lower-right felt px: ${lowerRightFelt}`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
