#!/usr/bin/env node
// Solitaire maximize → restore round-trip. Clicks the maximize button,
// then clicks the (now-restore) button at its post-maximize position,
// and verifies:
//   1. After max click: window grows to (0,0,640,480) and the WAT-side
//      maximized flag flips on.
//   2. After second click on the restore button: window returns to its
//      original (x,y,w,h). Without the SC_MAXIMIZE↔SC_RESTORE toggle in
//      the HTMAXBUTTON handler, the second click would just resend
//      SC_MAXIMIZE and JS host_sys_command's `if (!_maximized)` guard
//      would no-op — leaving the window stuck maximized.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'entertainment-pack', 'sol.exe');

if (!fs.existsSync(EXE)) { console.log('SKIP  sol.exe not found'); process.exit(0); }

// Sol starts at (20,20) 593x431. Original max button: x = 20+593-39+8 = 582,
// y = 20+5+7 = 32. After maximize → window is (0,0,640,480), so the
// (now-restore) button sits at x = 640-39+8 = 609, y = 5+7 = 12.
const MAX_X_BEFORE = 582, MAX_Y_BEFORE = 32;
const MAX_X_AFTER  = 609, MAX_Y_AFTER  = 12;

const inputSpec = [
  `60:png:/tmp/sol_mr_0.png`,
  // First click: maximize.
  `80:mousedown:${MAX_X_BEFORE}:${MAX_Y_BEFORE}`,
  `81:mouseup:${MAX_X_BEFORE}:${MAX_Y_BEFORE}`,
  `140:png:/tmp/sol_mr_1.png`,
  // Second click on the now-restore button: should restore.
  `200:mousedown:${MAX_X_AFTER}:${MAX_Y_AFTER}`,
  `201:mouseup:${MAX_X_AFTER}:${MAX_Y_AFTER}`,
  `320:png:/tmp/sol_mr_2.png`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --dump-backcanvas --input='${inputSpec}' --max-batches=400`;
console.log('$', cmd.replace(ROOT, '.'));

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 120000, cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

function parseRect(line) {
  const m = line.match(/pos=(-?\d+),(-?\d+) size=(\d+)x(\d+)/);
  if (!m) return null;
  return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
}

const winLines = out.split('\n').filter(l => l.includes('[input] window hwnd=65537'));
// Snapshots in input file: t=60, 140, 320 → roughly the 1st, 2nd, 3rd recorded rects
const rects = winLines.map(parseRect).filter(Boolean);
const initRect = rects[0];
const lastRect = rects[rects.length - 1];

// Find a rect whose snapshot was taken between the first and second click —
// expected to be (0,0,640,480) after the maximize.
const maxRect = rects.find(r => r.x === 0 && r.y === 0 && r.w >= 640 && r.h >= 480);

const checks = [
  { name: 'Solitaire launched',                     pass: !!initRect },
  { name: 'maximized to full screen after 1st click',pass: !!maxRect },
  { name: 'restored to original geom after 2nd',
    pass: !!(lastRect && initRect &&
              lastRect.x === initRect.x && lastRect.y === initRect.y &&
              lastRect.w === initRect.w && lastRect.h === initRect.h) },
  { name: 'no UNIMPLEMENTED API crash',              pass: !/UNIMPLEMENTED API:/.test(out) },
];

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`init:    ${JSON.stringify(initRect)}`);
console.log(`maxRect: ${JSON.stringify(maxRect)}`);
console.log(`final:   ${JSON.stringify(lastRect)}`);
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
