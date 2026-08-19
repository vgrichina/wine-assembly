#!/usr/bin/env node
// Minesweeper is the canonical non-resizable top-level window: style
// 0xca0000 = WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX, no WS_THICKFRAME,
// no WS_MAXIMIZEBOX. This test pins down that:
//   1. Dragging any edge/corner does NOT resize the window (the guest
//      style forbids it — we should never let the host resize past it).
//   2. Clicking in the strip where a maximize button would sit has no
//      effect (minesweeper's caption renders with close only).
//
// Defense against a regression: once resize is implemented for windows
// that do have WS_THICKFRAME, the implementation must gate on style.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'entertainment-pack', 'winmine.exe');

if (!fs.existsSync(EXE)) { console.log('SKIP  winmine.exe not found'); process.exit(0); }

// Minesweeper default: pos=(78,40) size=154x235.
const WIN = { x: 78, y: 40, w: 154, h: 235 };

// Bottom-right corner + bogus "max button" position (where it'd live in
// the caption if the style had WS_MAXIMIZEBOX — style-less caption still
// only shows close).
const BR_X = WIN.x + WIN.w - 1, BR_Y = WIN.y + WIN.h - 1;
const MAX_X = WIN.x + (WIN.w - 39) + 8;
const MAX_Y = WIN.y + 5 + 7;

const inputSpec = [
  // Attempt edge drag
  `80:mousedown:${BR_X}:${BR_Y}`,
  `82:mousemove:${BR_X + 40}:${BR_Y + 40}`,
  `84:mouseup:${BR_X + 40}:${BR_Y + 40}`,
  // Attempt max-button click
  `100:mousedown:${MAX_X}:${MAX_Y}`,
  `101:mouseup:${MAX_X}:${MAX_Y}`,
  `160:png:/tmp/mine_no_resize.png`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --dump-backcanvas --input='${inputSpec}' --max-batches=200`;
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
const lastRect = winLines[winLines.length - 1] && parseRect(winLines[winLines.length - 1]);

const widthUnchanged  = lastRect && lastRect.w === WIN.w;
const heightUnchanged = lastRect && lastRect.h === WIN.h;
const notMaximized    = lastRect && !(lastRect.x === 0 && lastRect.y === 0 &&
                                      lastRect.w >= 600 && lastRect.h >= 400);

const checks = [
  { name: 'Minesweeper window observed',              pass: !!lastRect },
  { name: 'width unchanged after corner-drag attempt',pass: !!widthUnchanged },
  { name: 'height unchanged after corner-drag attempt',pass: !!heightUnchanged },
  { name: 'window NOT maximized by pseudo-max click', pass: !!notMaximized },
];

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`final rect: ${JSON.stringify(lastRect)}  (expected w=${WIN.w}, h=${WIN.h})`);
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
