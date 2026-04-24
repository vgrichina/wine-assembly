#!/usr/bin/env node
// MSPaint Win98 drawing regression. Proves that a mouse drag inside the
// white canvas area actually produces pixels on the back-canvas via the
// pencil tool (the default on startup).
//
// Strategy: one run. After layout settles we snapshot the renderer to a
// "before" PNG, issue mousedown + several mousemoves + mouseup across the
// canvas area, let the app repaint, then snapshot an "after" PNG. The
// test asserts that a significant number of pixels in the canvas bounding
// box changed between the two snapshots.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadImage, createCanvas } = require('canvas');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'mspaint.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

const OUT = path.join(ROOT, 'scratch');
fs.mkdirSync(OUT, { recursive: true });
const pngBefore = path.join(OUT, 'mspaint_draw_before.png');
const pngAfter  = path.join(OUT, 'mspaint_draw_after.png');
for (const p of [pngBefore, pngAfter]) { try { fs.unlinkSync(p); } catch (_) {} }

// Frame at screen (20,20), client (23,61). MDI canvas at client+(57,0),
// size 212x283 → screen bbox roughly (80,61)..(292,344). Inside the white
// area of the image a drag from (140,170) down-right through (240,260) is
// well inside the document window.
//
// Tools palette renders on the left side of the frame; the pencil tool
// icon sits at screen (39, 146) — Tools palette button 0x10010, menu=636
// (the pencil). We click it first so the subsequent drag lays down actual
// pencil pixels instead of a marching-ants selection marquee.
const toolClickBatch = 50;
const PENCIL_X = 39, PENCIL_Y = 146;
const drag = [];
const STEPS = 12;
const x0 = 140, y0 = 170, x1 = 240, y1 = 260;
drag.push(`60:mousedown:${x0}:${y0}`);
for (let i = 1; i < STEPS; i++) {
  const t = i / STEPS;
  const x = Math.round(x0 + (x1 - x0) * t);
  const y = Math.round(y0 + (y1 - y0) * t);
  drag.push(`${60 + i}:mousemove:${x}:${y}`);
}
drag.push(`${60 + STEPS}:mouseup:${x1}:${y1}`);

const inputSpec = [
  `40:png:${pngBefore}`,
  `${toolClickBatch}:mousedown:${PENCIL_X}:${PENCIL_Y}`,
  `${toolClickBatch + 1}:mouseup:${PENCIL_X}:${PENCIL_Y}`,
  ...drag,
  `120:png:${pngAfter}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --input=${inputSpec} --max-batches=140 --batch-size=50000 --no-close`;
console.log('$', cmd);

let out = '';
let exitCode = 0;
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 120000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  exitCode = e.status ?? 1;
  console.log(`(run.js exited non-zero status=${exitCode} — output captured)`);
}

const hasCreateMain = /\[CreateWindow\] hwnd=0x10001 title="Paint"/.test(out);
const hasTools      = /title="Tools"/.test(out);
const hasColors     = /title="Colors"/.test(out);
const hasUnimpl     = /UNIMPLEMENTED API:/.test(out);
const beforeExists  = fs.existsSync(pngBefore) && fs.statSync(pngBefore).size > 0;
const afterExists   = fs.existsSync(pngAfter)  && fs.statSync(pngAfter).size  > 0;

// Canvas-region pixel diff. Bounding box deliberately avoids the window
// chrome / palettes so cursor or status-bar flicker doesn't show up.
const BBOX = { x0: 90, y0: 130, x1: 285, y1: 290 };

async function countDiffPixels() {
  if (!beforeExists || !afterExists) return -1;
  const [a, b] = await Promise.all([loadImage(pngBefore), loadImage(pngAfter)]);
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const ca = createCanvas(w, h), cb = createCanvas(w, h);
  ca.getContext('2d').drawImage(a, 0, 0);
  cb.getContext('2d').drawImage(b, 0, 0);
  const da = ca.getContext('2d').getImageData(0, 0, w, h).data;
  const db = cb.getContext('2d').getImageData(0, 0, w, h).data;
  let diff = 0;
  for (let y = BBOX.y0; y < Math.min(BBOX.y1, h); y++) {
    for (let x = BBOX.x0; x < Math.min(BBOX.x1, w); x++) {
      const i = (y * w + x) * 4;
      if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2]) diff++;
    }
  }
  return diff;
}

(async () => {
  const diffPixels = await countDiffPixels();
  const checks = [
    { name: 'main window created (untitled - Paint)', pass: hasCreateMain },
    { name: 'Tools palette created',                   pass: hasTools },
    { name: 'Colors palette created',                  pass: hasColors },
    { name: 'no UNIMPLEMENTED API crash',              pass: !hasUnimpl },
    { name: 'before PNG snapshot written',             pass: beforeExists },
    { name: 'after PNG snapshot written',              pass: afterExists },
    { name: `canvas pixels changed after drag (>=20)`, pass: diffPixels >= 20 },
  ];

  console.log('');
  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log(`diff pixels in canvas bbox: ${diffPixels}`);
  console.log('');
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
})();
