#!/usr/bin/env node
// Solitaire resize regression. Drags the bottom-right corner of the
// Solitaire window outward and verifies the window actually grew.
//
// Solitaire has WS_THICKFRAME (style 0x2cf0000) so it's supposed to be
// user-resizable. Both halves of that (HTBOTTOMRIGHT from
// $defwndproc_do_nchittest, and renderer-input.js's drag-to-resize) are
// implemented now.
//
// The grab point comes from the window's live rect via corner-drag, not from
// a hardcoded screen coordinate: this test spent months failing because it
// assumed Solitaire opened at y=20 when it actually opens at y=0, so the
// mousedown landed 19px below the window and grabbed nothing. (That y=0 is
// itself an emulator bug — CreateWindowExA is passed x=CW_USEDEFAULT, y=0,
// and Windows ignores y entirely in that case. Tracked separately; it moves
// every window and needs its own e2e recalibration.)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'entertainment-pack', 'sol.exe');

if (!fs.existsSync(EXE)) { console.log('SKIP  sol.exe not found'); process.exit(0); }

// Solitaire opens 593x431. Drag its bottom-right corner by +18,+20.
const GROW_W = 18, GROW_H = 20;

const inputSpec = [
  `60:corner-drag:10001:${GROW_W}:${GROW_H}`,
  `120:png:/tmp/sol_resize_after.png`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --dump-backcanvas --input='${inputSpec}' --max-batches=150`;
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

const GREW_W = lastRect && lastRect.w === 593 + GROW_W;
const GREW_H = lastRect && lastRect.h === 431 + GROW_H;

const checks = [
  { name: 'Solitaire window observed',        pass: !!lastRect },
  { name: 'width grew after corner drag',     pass: !!GREW_W },
  { name: 'height grew after corner drag',    pass: !!GREW_H },
];

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`final rect: ${JSON.stringify(lastRect)}  (expected ${593 + GROW_W}x${431 + GROW_H})`);
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
