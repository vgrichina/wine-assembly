#!/usr/bin/env node
// Spider drag regression: a small post-drag invalidation must not let
// BeginPaint's erase wipe the whole table outside rcPaint.

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

const basePng = path.join(TMP, 'spider_drag_base.png');
const midPng  = path.join(TMP, 'spider_drag_mid.png');
const endPng  = path.join(TMP, 'spider_drag_end.png');
for (const p of [basePng, midPng, endPng]) { try { fs.unlinkSync(p); } catch (_) {} }

const inputSpec = [
  `200:png:${basePng}`,
  '260:mousedown:620:135',
  '280:mousemove:560:180',
  '300:mousemove:500:220',
  '320:mousemove:440:260',
  `340:png:${midPng}`,
  '380:mouseup:440:260',
  `700:png:${endPng}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --dlls="${DLL}" --no-close --input=${inputSpec} --max-batches=850 --batch-size=50000 --quiet-api`;
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

const sizeOf = p => fs.existsSync(p) ? fs.statSync(p).size : 0;
const baseSize = sizeOf(basePng);
const midSize = sizeOf(midPng);
const endSize = sizeOf(endPng);

function statusTextPixels(pngPath) {
  if (!fs.existsSync(pngPath)) return 0;
  const img = PNG.sync.read(fs.readFileSync(pngPath));
  let count = 0;
  const bands = [
    [14, 85],   // Score
    [96, 160],  // Moves
    [176, 280], // Rows Remaining
    [290, 365], // Suits Removed
  ];
  for (const [x1, x2] of bands) {
    for (let y = img.height - 18; y < img.height - 9; y++) {
      for (let x = x1; x < x2; x++) {
        const i = (y * img.width + x) * 4;
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        if (!(r === 0 && g === 128 && b === 0)) count++;
      }
    }
  }
  return count;
}

const statusPixels = statusTextPixels(endPng);

function countColorInRect(pngPath, x1, y1, x2, y2, rgb) {
  if (!fs.existsSync(pngPath)) return 0;
  const img = PNG.sync.read(fs.readFileSync(pngPath));
  let count = 0;
  const top = y1 < 0 ? img.height + y1 : y1;
  const bottom = y2 < 0 ? img.height + y2 : y2;
  for (let y = Math.max(0, top); y < Math.min(img.height, bottom); y++) {
    for (let x = Math.max(0, x1); x < Math.min(img.width, x2); x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] === rgb[0] && img.data[i + 1] === rgb[1] && img.data[i + 2] === rgb[2]) count++;
    }
  }
  return count;
}

const suitRect = [350, -28, 480, -5];
const badSuitColors =
  countColorInRect(endPng, ...suitRect, [0, 255, 255]) +
  countColorInRect(endPng, ...suitRect, [255, 255, 0]) +
  countColorInRect(endPng, ...suitRect, [0, 128, 0]);
const redSuitPixels = countColorInRect(endPng, ...suitRect, [255, 0, 0]);
const blackSuitPixels = countColorInRect(endPng, ...suitRect, [0, 0, 0]);

const checks = [
  { name: 'process exited cleanly', pass: exitCode === 0 },
  { name: 'baseline PNG written', pass: baseSize > 20000 },
  { name: 'mid-drag PNG written', pass: midSize > 20000 },
  { name: 'post-release PNG keeps full tableau', pass: endSize > 20000 },
  { name: 'post-release PNG keeps Spider status text', pass: statusPixels > 500 },
  { name: 'Spider status suit icons use main EXE bitmaps', pass: badSuitColors === 0 && redSuitPixels > 20 && blackSuitPixels > 20 },
  { name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) },
  { name: 'no crash marker', pass: !/CRASH|LinkError/.test(out) },
];

let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`sizes: base=${baseSize} mid=${midSize} end=${endSize} statusTextPixels=${statusPixels} badSuitColors=${badSuitColors} redSuitPixels=${redSuitPixels} blackSuitPixels=${blackSuitPixels}`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
