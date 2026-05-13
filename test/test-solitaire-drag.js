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
const { execSync } = require('child_process');

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
  `210:png-raw:${basePng}`,                       // baseline PNG
  `220:mousedown:${PICK_X}:${PICK_Y}`,            // grab card
  mv(225, PICK_X + 120, PICK_Y + 20),
  mv(230, PICK_X + 260, PICK_Y + 50),
  mv(235, PICK_X + 420, PICK_Y + 80),
  `240:png-raw:${midPng}`,                        // mid-drag PNG
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
process.exit((sizeOf(basePng) && sizeOf(midPng) && sizeOf(endPng)) ? 0 : 1);
