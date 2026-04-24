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

// Tools palette (left column) and Colors palette (bottom strip) bboxes —
// both should still show their non-uniform content in the "after" PNG, i.e.
// a repaint triggered by the canvas drag must not wipe them off the back-
// canvas. We assert that each region contains at least a minimum number of
// non-background-color pixels.
const TOOLS_BBOX  = { x0: 28, y0: 75, x1: 82, y1: 310 };   // 16 tool icons
const COLORS_BBOX = { x0: 40, y0: 335, x1: 285, y1: 378 }; // 28 color swatches

async function readPixels(p) {
  const img = await loadImage(p);
  const cv = createCanvas(img.width, img.height);
  cv.getContext('2d').drawImage(img, 0, 0);
  return { w: img.width, h: img.height, data: cv.getContext('2d').getImageData(0, 0, img.width, img.height).data };
}

function countDiffPixels(A, B, bbox) {
  const w = Math.min(A.w, B.w), h = Math.min(A.h, B.h);
  let diff = 0;
  for (let y = bbox.y0; y < Math.min(bbox.y1, h); y++) {
    for (let x = bbox.x0; x < Math.min(bbox.x1, w); x++) {
      const i = (y * w + x) * 4;
      if (A.data[i] !== B.data[i] || A.data[i + 1] !== B.data[i + 1] || A.data[i + 2] !== B.data[i + 2]) diff++;
    }
  }
  return diff;
}

// Count pixels in bbox that are NOT the background color (grey btnFace or
// teal desktop). Palettes have black icons / colored swatches that differ
// from either background, so a healthy palette has many such pixels.
function countNonBgPixels(img, bbox) {
  const w = img.w;
  let n = 0;
  for (let y = bbox.y0; y < Math.min(bbox.y1, img.h); y++) {
    for (let x = bbox.x0; x < Math.min(bbox.x1, w); x++) {
      const i = (y * w + x) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      // grey (frame bg), teal (desktop), white (canvas doc)
      const isGrey  = (r === 0xC0 && g === 0xC0 && b === 0xC0);
      const isTeal  = (r === 0x00 && g === 0x80 && b === 0x80);
      const isWhite = (r === 0xFF && g === 0xFF && b === 0xFF);
      if (!isGrey && !isTeal && !isWhite) n++;
    }
  }
  return n;
}

(async () => {
  let diffPixels = -1, toolsPxBefore = -1, toolsPxAfter = -1, colorsPxBefore = -1, colorsPxAfter = -1;
  if (beforeExists && afterExists) {
    const [A, B] = await Promise.all([readPixels(pngBefore), readPixels(pngAfter)]);
    diffPixels     = countDiffPixels(A, B, BBOX);
    toolsPxBefore  = countNonBgPixels(A, TOOLS_BBOX);
    toolsPxAfter   = countNonBgPixels(B, TOOLS_BBOX);
    colorsPxBefore = countNonBgPixels(A, COLORS_BBOX);
    colorsPxAfter  = countNonBgPixels(B, COLORS_BBOX);
  }
  // Accept a mild drop from the "before" baseline to tolerate anti-aliasing
  // / focus highlights, but fail if the palette effectively vanished.
  const toolsSurvived  = toolsPxAfter  >= Math.max(200, toolsPxBefore  * 0.5);
  const colorsSurvived = colorsPxAfter >= Math.max(200, colorsPxBefore * 0.5);
  const checks = [
    { name: 'main window created (untitled - Paint)', pass: hasCreateMain },
    { name: 'Tools palette created',                   pass: hasTools },
    { name: 'Colors palette created',                  pass: hasColors },
    { name: 'no UNIMPLEMENTED API crash',              pass: !hasUnimpl },
    { name: 'before PNG snapshot written',             pass: beforeExists },
    { name: 'after PNG snapshot written',              pass: afterExists },
    { name: `canvas pixels changed after drag (>=20)`, pass: diffPixels >= 20 },
    { name: `Tools palette still visible after drag`,  pass: toolsSurvived },
    { name: `Colors palette still visible after drag`, pass: colorsSurvived },
  ];

  console.log('');
  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log(`diff pixels in canvas bbox: ${diffPixels}`);
  console.log(`tools palette non-bg px:   before=${toolsPxBefore}  after=${toolsPxAfter}`);
  console.log(`colors palette non-bg px:  before=${colorsPxBefore} after=${colorsPxAfter}`);
  console.log('');
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
})();
