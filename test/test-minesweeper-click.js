#!/usr/bin/env node
// Minesweeper click regression: a normal single click must arrive as
// WM_LBUTTONDOWN, not an accidental WM_LBUTTONDBLCLK, and reveal a cell.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createCanvas, loadImage } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'entertainment-pack', 'winmine.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  winmine.exe not found');
  process.exit(0);
}

const beforePng = path.join(ROOT, 'scratch', 'mine-click-before.png');
const afterPng = path.join(ROOT, 'scratch', 'mine-click-after.png');
fs.mkdirSync(path.dirname(beforePng), { recursive: true });
for (const p of [beforePng, afterPng]) {
  try { fs.unlinkSync(p); } catch (_) {}
}

const inputSpec = [
  `80:png:${beforePng}`,
  '100:mousedown:105:150',
  '120:mouseup:105:150',
  `300:png:${afterPng}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --input='${inputSpec}' --max-batches=500 --quiet-api`;
console.log('$', cmd.replace(ROOT, '.'));

let out = '';
try {
  out = execSync(cmd, {
    encoding: 'utf-8', timeout: 120000, cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

async function diffPngs(aPath, bPath) {
  const a = await loadImage(aPath);
  const b = await loadImage(bPath);
  const w = a.width, h = a.height;
  if (b.width !== w || b.height !== h) return -1;
  const ca = createCanvas(w, h), cb = createCanvas(w, h);
  ca.getContext('2d').drawImage(a, 0, 0);
  cb.getContext('2d').drawImage(b, 0, 0);
  const da = ca.getContext('2d').getImageData(0, 0, w, h).data;
  const db = cb.getContext('2d').getImageData(0, 0, w, h).data;
  let diff = 0;
  for (let i = 0; i < da.length; i += 4) {
    if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2]) diff++;
  }
  return diff;
}

(async () => {
  const diff = fs.existsSync(beforePng) && fs.existsSync(afterPng)
    ? await diffPngs(beforePng, afterPng)
    : 0;
  console.log(`  before/after diff: ${diff}px`);

  const checks = [
    { name: 'before snapshot written', pass: fs.existsSync(beforePng) && fs.statSync(beforePng).size > 1000 },
    { name: 'after snapshot written', pass: fs.existsSync(afterPng) && fs.statSync(afterPng).size > 1000 },
    { name: 'single click delivered as WM_LBUTTONDOWN', pass: /\[check_input\] msg=0x201\b/.test(out) },
    { name: 'single click not delivered as WM_LBUTTONDBLCLK', pass: !/\[check_input\] msg=0x203\b/.test(out) },
    { name: 'cell click changes board pixels', pass: diff >= 100 },
    { name: 'no crash', pass: !/\*\*\* CRASH|UNIMPLEMENTED API:|LinkError/.test(out) },
  ];

  console.log('');
  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log('');
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
