#!/usr/bin/env node
// Spider Game -> Show An Available Move should return to normal input.
// A previous web path looked like a hang after this menu command; verify
// the real menu item can run and a subsequent Deal! command still changes
// the board.

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

const beforePng = path.join(TMP, 'spider_showmove_before_deal.png');
const afterPng = path.join(TMP, 'spider_showmove_after_deal.png');
for (const p of [beforePng, afterPng]) { try { fs.unlinkSync(p); } catch (_) {} }

const inputSpec = [
  '200:click:34:31',       // Game
  '240:click:90:151',      // Show An Available Move
  `340:png:${beforePng}`,
  '380:click:67:31',       // Deal!
  `620:png:${afterPng}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --dlls="${DLL}" --no-close --input=${inputSpec} --max-batches=760 --batch-size=50000 --quiet-api`;
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

function imageDiff(aPath, bPath) {
  if (!fs.existsSync(aPath) || !fs.existsSync(bPath)) return 0;
  const a = PNG.sync.read(fs.readFileSync(aPath));
  const b = PNG.sync.read(fs.readFileSync(bPath));
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  let diff = 0;
  for (let y = 40; y < Math.min(h, 220); y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      if (a.data[i] !== b.data[j] ||
          a.data[i + 1] !== b.data[j + 1] ||
          a.data[i + 2] !== b.data[j + 2]) diff++;
    }
  }
  return diff;
}

const diff = imageDiff(beforePng, afterPng);
const checks = [
  { name: 'run.js exited cleanly', pass: exitCode === 0 },
  { name: 'pre-deal PNG written after Show Available Move', pass: fs.existsSync(beforePng) && fs.statSync(beforePng).size > 1000 },
  { name: 'post-command Deal! remains responsive', pass: diff > 5000 },
  { name: 'no crash marker', pass: !/UNIMPLEMENTED API|ERROR:|Fatal/i.test(out) },
];

let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`board diff after Deal!: ${diff}`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
