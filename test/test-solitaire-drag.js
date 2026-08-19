#!/usr/bin/env node
// Solitaire drag repro: pick up a tableau card and drag it across the window
// to reproduce the card-sized black trail bug seen in the browser.
//
// Flow:
//   1. Launch sol.exe
//   2. Dismiss initial assertion dialogs
//   3. Snapshot baseline (initial deal)
//   4. mousedown on the leftmost tableau pile's face-up card
//   5. mousemove across the green felt in several steps, png mid-drag
//   6. mouseup
//   7. Snapshot final
//
// Artifacts:
//   scratch/sol_drag_base.png    — after initial deal
//   scratch/sol_drag_mid.png     — mid-drag, should reveal any trail
//   scratch/sol_drag_end.png     — after mouseup

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'entertainment-pack', 'sol.exe');
const TMP  = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });

const basePng = path.join(TMP, 'sol_drag_base.png');
const midPng  = path.join(TMP, 'sol_drag_mid.png');
const endPng  = path.join(TMP, 'sol_drag_end.png');
for (const p of [basePng, midPng, endPng]) { try { fs.unlinkSync(p); } catch (_) {} }

// Tableau pile 0 face-up card sits roughly at (50, 230) in canvas coords
// (below the deck row at y≈130). Drag it ~400px to the right across empty felt.
const PICK_X = 50, PICK_Y = 230;

const dismiss = (start, count, step) =>
  Array.from({length: count}, (_, i) => `${start + i * step}:0x111:1`);

const mv = (batch, x, y) => `${batch}:mousemove:${x}:${y}`;

const inputSpec = [
  ...dismiss(50, 4, 40),                          // dismiss initial assertion dialogs
  `210:hwnd-png-pixels:65537:${basePng}`,         // canonical baseline window pixels
  `220:mousedown:${PICK_X}:${PICK_Y}`,            // grab card
  mv(225, PICK_X + 120, PICK_Y + 20),
  mv(230, PICK_X + 260, PICK_Y + 50),
  mv(235, PICK_X + 420, PICK_Y + 80),
  `240:hwnd-png-pixels:65537:${midPng}`,          // canonical mid-drag window pixels
  `245:mouseup:${PICK_X + 420}:${PICK_Y + 80}`,   // release (invalid target → snap back)
  `255:hwnd-png-pixels:65537:${endPng}`,          // main-window PNG after release
  `256:stop`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --input='${inputSpec}' --max-batches=270 --quiet-api --quiet-blocks`;
console.log('$', cmd.replace(ROOT, '.'));

let out = '';
try {
  out = execSync(cmd, {
    encoding: 'utf-8', timeout: 240000, cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

const interesting = out.split('\n').filter(l =>
  l.includes('UNIMPLEMENTED') || l.includes('CRASH') || l.includes('LinkError') ||
  l.includes('[input]'));
for (const l of interesting) console.log('  ' + l);

const sizeOf = p => (fs.existsSync(p) && fs.statSync(p).size > 1000);
console.log('');
console.log('baseline:', sizeOf(basePng) ? basePng : 'MISSING');
console.log('mid-drag:', sizeOf(midPng)  ? midPng  : 'MISSING');
console.log('end:     ', sizeOf(endPng)  ? endPng  : 'MISSING');
assert(sizeOf(basePng) && sizeOf(midPng) && sizeOf(endPng),
  'Solitaire drag snapshots must all be present and nontrivial');

const base = PNG.sync.read(fs.readFileSync(basePng));
const mid = PNG.sync.read(fs.readFileSync(midPng));
const end = PNG.sync.read(fs.readFileSync(endPng));
assert.deepStrictEqual([mid.width, mid.height], [base.width, base.height]);
assert.deepStrictEqual([end.width, end.height], [base.width, base.height]);

let midDelta = 0;
let endDelta = 0;
let redCardPixels = 0;
const playfieldHeight = base.height - 24;
for (let y = 0; y < playfieldHeight; y++) {
  for (let x = 0; x < base.width; x++) {
    const i = (y * base.width + x) * 4;
    if (base.data[i] > 180 && base.data[i + 1] < 100 && base.data[i + 2] < 100) {
      redCardPixels++;
    }
    const midChanged = base.data[i] !== mid.data[i] ||
      base.data[i + 1] !== mid.data[i + 1] || base.data[i + 2] !== mid.data[i + 2];
    const endChanged = base.data[i] !== end.data[i] ||
      base.data[i + 1] !== end.data[i + 1] || base.data[i + 2] !== end.data[i + 2];
    if (midChanged) midDelta++;
    if (endChanged) endDelta++;
  }
}
console.log(`playfield pixel delta: mid=${midDelta} end=${endDelta}; red=${redCardPixels}`);
assert(redCardPixels > 500,
  'Solitaire must preserve red suit and face-card pixels through monochrome/color blits');
assert(midDelta > 1000, 'mid-drag snapshot must show the card moved across the felt');
assert.strictEqual(endDelta, 0,
  'invalid drop must restore the exact pre-drag window without card trails');
console.log('PASS  Solitaire drag restores the canonical window surface exactly');
