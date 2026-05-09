#!/usr/bin/env node
// Minesweeper regression: after losing, clicking the smiley face must reset.
// Winmine tracks the face press in a modal PeekMessage mouse loop, so this
// covers MSG.pt/GetMessagePos bookkeeping as well as capture mouse-up delivery.

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

const beforePng = path.join(ROOT, 'scratch', 'mine-smiley-before.png');
const lostPng = path.join(ROOT, 'scratch', 'mine-smiley-lost.png');
const resetPng = path.join(ROOT, 'scratch', 'mine-smiley-reset.png');
fs.mkdirSync(path.dirname(beforePng), { recursive: true });
for (const p of [beforePng, lostPng, resetPng]) {
  try { fs.unlinkSync(p); } catch (_) {}
}

const loseClicks = [100, 116, 132, 148, 164, 180, 196, 212, 228]
  .flatMap((x, i) => [`${100 + i * 10}:mousedown:${x}:143`, `${104 + i * 10}:mouseup:${x}:143`]);

const inputSpec = [
  `80:png:${beforePng}`,
  ...loseClicks,
  `220:png:${lostPng}`,
  '260:mousedown:157:109',
  '270:mouseup:157:109',
  `400:png:${resetPng}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --input='${inputSpec}' --max-batches=460 --quiet-api`;
console.log('$', cmd.replace(ROOT, '.'));

let out = '';
try {
  out = execSync(cmd, {
    encoding: 'utf-8',
    timeout: 120000,
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero - output captured)');
}

async function diffPngs(aPath, bPath) {
  const a = await loadImage(aPath);
  const b = await loadImage(bPath);
  if (b.width !== a.width || b.height !== a.height) return -1;
  const ca = createCanvas(a.width, a.height);
  const cb = createCanvas(b.width, b.height);
  ca.getContext('2d').drawImage(a, 0, 0);
  cb.getContext('2d').drawImage(b, 0, 0);
  const da = ca.getContext('2d').getImageData(0, 0, a.width, a.height).data;
  const db = cb.getContext('2d').getImageData(0, 0, b.width, b.height).data;
  let diff = 0;
  for (let i = 0; i < da.length; i += 4) {
    if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2]) diff++;
  }
  return diff;
}

(async () => {
  const beforeLost = fs.existsSync(beforePng) && fs.existsSync(lostPng)
    ? await diffPngs(beforePng, lostPng)
    : 0;
  const beforeReset = fs.existsSync(beforePng) && fs.existsSync(resetPng)
    ? await diffPngs(beforePng, resetPng)
    : -1;
  const lostReset = fs.existsSync(lostPng) && fs.existsSync(resetPng)
    ? await diffPngs(lostPng, resetPng)
    : 0;

  console.log(`  before/lost diff: ${beforeLost}px`);
  console.log(`  before/reset diff: ${beforeReset}px`);
  console.log(`  lost/reset diff: ${lostReset}px`);

  const checks = [
    { name: 'before snapshot written', pass: fs.existsSync(beforePng) && fs.statSync(beforePng).size > 1000 },
    { name: 'lost snapshot written', pass: fs.existsSync(lostPng) && fs.statSync(lostPng).size > 1000 },
    { name: 'reset snapshot written', pass: fs.existsSync(resetPng) && fs.statSync(resetPng).size > 1000 },
    { name: 'losing clicks changed the board', pass: beforeLost >= 1000 },
    { name: 'smiley reset changed the lost board', pass: lostReset >= 1000 },
    { name: 'reset returns to hidden-board pixels', pass: beforeReset === 0 },
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
