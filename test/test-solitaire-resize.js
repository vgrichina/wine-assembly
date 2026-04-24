#!/usr/bin/env node
// Solitaire resize regression. Drags the bottom-right corner of the
// Solitaire window outward and verifies the window actually grew.
//
// Solitaire has WS_THICKFRAME (style 0x2cf0000) so it's supposed to be
// user-resizable. Currently (2026-04-24) this test fails end-to-end:
//   - $defwndproc_do_nchittest never returns HTBOTTOMRIGHT/HTLEFT/etc;
//     any click in the 3px border collapses to HTBORDER (non-interactive).
//   - renderer-input.js has no edge hit-detection or drag-to-resize path.
// So the test will fail until both halves are implemented. Kept as a
// live regression target.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'entertainment-pack', 'sol.exe');

if (!fs.existsSync(EXE)) { console.log('SKIP  sol.exe not found'); process.exit(0); }

// Solitaire default: pos=(20,20) size=593x431.
// Bottom-right corner at screen (20+593-1, 20+431-1) = (612, 450).
// Drag it to (630, 470) => +18w, +20h.
const BR_X = 20 + 593 - 1, BR_Y = 20 + 431 - 1;
const NEW_X = 630, NEW_Y = 470;

const inputSpec = [
  `60:mousedown:${BR_X}:${BR_Y}`,
  `62:mousemove:${BR_X + 5}:${BR_Y + 5}`,
  `64:mousemove:${BR_X + 10}:${BR_Y + 10}`,
  `66:mousemove:${NEW_X}:${NEW_Y}`,
  `68:mouseup:${NEW_X}:${NEW_Y}`,
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

const GREW_W = lastRect && lastRect.w > 593 + 10;
const GREW_H = lastRect && lastRect.h > 431 + 10;

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
console.log(`final rect: ${JSON.stringify(lastRect)}  (expected w>603, h>441)`);
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
