#!/usr/bin/env node
// Window show state: what the guest is told vs what the renderer believes.
//
// Minimized/maximized used to have two owners. The renderer kept
// win._minimized / win._maximized so it could composite, and WAT kept a
// maximized bit so the caption could draw the right glyph -- but the four
// APIs a guest asks with all answered with a constant: IsIconic 0, IsZoomed
// 0, GetWindowPlacement showCmd SW_SHOWNORMAL, and SetWindowPlacement threw
// showCmd away. So an app could minimize itself and then be told it hadn't.
//
// This drives Solitaire's own caption buttons and checks the two owners
// against each other at every step, including the case they most easily
// disagree on: minimizing a maximized window. Windows treats the two as
// independent conditions -- such a window comes back maximized -- so the
// maximized bit must survive the minimize.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'entertainment-pack', 'sol.exe');

if (!fs.existsSync(EXE)) { console.log('SKIP  sol.exe not found'); process.exit(0); }

// Caption button geometry (see $defwndproc_do_nchittest): bw=16, bh=14,
// btn_y = cap_top + 2 = 5, so a button centre is +8,+7 from its corner.
//   close_x = w-21, max_x = w-39, min_x = w-55  (window-local)
// Solitaire starts at (20,20) 593x431; maximized it is (0,0) 640x480.
const btn = (x, y, w, dx) => [x + w - dx + 8, y + 5 + 7];
const [MAX_X, MAX_Y] = btn(20, 20, 593, 39);
const [MIN_X, MIN_Y] = btn(0, 0, 640, 55);

const inputSpec = [
  '60:dump-windows:start',
  `80:mousedown:${MAX_X}:${MAX_Y}`,
  `81:mouseup:${MAX_X}:${MAX_Y}`,
  '120:dump-windows:maxed',
  `140:mousedown:${MIN_X}:${MIN_Y}`,
  `141:mouseup:${MIN_X}:${MIN_Y}`,
  '180:dump-windows:mined',
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --input='${inputSpec}' --max-batches=220`;
console.log('$', cmd.replace(ROOT, '.'));

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 120000, cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero -- output captured)');
}

const lines = out.split('\n');

// The main window is the first top-level one the dump lists; take it by
// hwnd rather than by position so a stray child cannot stand in for it.
const MAIN = '65537';
function dumpLine(label) {
  return lines.find(l =>
    l.includes(`[input] window:${label} hwnd=${MAIN} `)) || '';
}
function flags(line) {
  const g = re => { const m = line.match(re); return m ? m[1] : null; };
  const rect = line.match(/pos=(-?\d+),(-?\d+) size=(\d+)x(\d+)/);
  return {
    ok: !!line,
    iconic: g(/ iconic=(\w+)/) === 'true',
    zoomed: g(/ zoomed=(\w+)/) === 'true',
    minimized: g(/ minimized=(\w+)/) === 'true',
    visible: g(/ visible=(\w+)/) === 'true',
    rect: rect ? { x: +rect[1], y: +rect[2], w: +rect[3], h: +rect[4] } : null,
  };
}

const start = flags(dumpLine('start'));
const maxed = flags(dumpLine('maxed'));
const mined = flags(dumpLine('mined'));

// Every dump of every window, so a disagreement anywhere shows up rather
// than only at the three sampled points.
const disagreements = lines.filter(l => l.includes('[input] window:') &&
  / iconic=/.test(l) && / minimized=/.test(l))
  .filter(l => {
    const f = flags(l);
    return f.iconic !== f.minimized;
  });

const checks = [
  { name: 'launched, not iconic and not zoomed at start',
    pass: start.ok && !start.iconic && !start.zoomed },
  { name: 'maximize click sets zoomed and full-screen rect',
    pass: maxed.ok && maxed.zoomed && !maxed.iconic &&
      !!maxed.rect && maxed.rect.x === 0 && maxed.rect.y === 0 &&
      maxed.rect.w >= 640 && maxed.rect.h >= 480 },
  { name: 'minimize click sets iconic and hides the window',
    pass: mined.ok && mined.iconic && !mined.visible },
  { name: 'maximized survives the minimize (restores to maximized)',
    pass: mined.ok && mined.zoomed },
  { name: 'guest IsIconic agrees with renderer minimized everywhere',
    pass: disagreements.length === 0 },
  { name: 'no UNIMPLEMENTED API crash',
    pass: !/UNIMPLEMENTED API:/.test(out) },
];

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`start: ${JSON.stringify(start)}`);
console.log(`maxed: ${JSON.stringify(maxed)}`);
console.log(`mined: ${JSON.stringify(mined)}`);
for (const d of disagreements.slice(0, 5)) console.log('disagree: ' + d.trim());
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
