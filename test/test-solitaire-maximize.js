#!/usr/bin/env node
// Solitaire maximize regression. Clicks the maximize button on the
// caption bar and verifies:
//   1. The renderer-side window geometry grows to (0,0, screen w/h).
//   2. The guest actually receives WM_SIZE — evidenced by the game
//      relaying out (pixels in the lower/right region change). Without
//      WM_SIZE, the app just has a bigger frame around its old
//      200x200-ish card area and the bottom-right stays empty grey.
//
// Currently (2026-04-24) this test fails step 2: host_sys_command in
// lib/host-imports.js updates win.{x,y,w,h} but never posts WM_SIZE,
// so solitaire doesn't know it was maximized.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
let createCanvas, loadImage;
try { ({ createCanvas, loadImage } = require('../lib/canvas-compat')); } catch (_) {}

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'entertainment-pack', 'sol.exe');

if (!fs.existsSync(EXE)) { console.log('SKIP  sol.exe not found'); process.exit(0); }
if (!createCanvas || !loadImage) { console.log('SKIP  node-canvas missing'); process.exit(0); }

const TMP = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });
const beforePng = path.join(TMP, 'sol_max_before.png');
const afterPng  = path.join(TMP, 'sol_max_after.png');
for (const p of [beforePng, afterPng]) { try { fs.unlinkSync(p); } catch (_) {} }

// Solitaire starts at (20,20) 593x431. Caption button geometry (see
// $defwndproc_do_nchittest): bw=16, bh=14, btn_y = cap_top+2 = 5.
//   close_x = w-21, max_x = w-39, min_x = w-55  (window-local)
// => max button center = win.x + max_x + 8, win.y + btn_y + 7
//                      = 20 + 593-39 + 8, 20 + 12 = (582, 32).
const MAX_X = 20 + (593 - 39) + 8;
const MAX_Y = 20 + 5 + 7;

const inputSpec = [
  `60:png:${beforePng}`,
  `80:mousedown:${MAX_X}:${MAX_Y}`,
  `81:mouseup:${MAX_X}:${MAX_Y}`,
  `160:png:${afterPng}`,
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

// Parse last [input] window hwnd=65537 ... line to learn post-click geom.
const winLines = out.split('\n').filter(l => l.includes('[input] window hwnd=65537'));
const firstRect = winLines[0] && parseRect(winLines[0]);
const lastRect  = winLines[winLines.length - 1] && parseRect(winLines[winLines.length - 1]);

function parseRect(line) {
  // Format: "[input] window hwnd=65537 pos=20,20 size=593x431 visible=true ..."
  const m = line.match(/pos=(-?\d+),(-?\d+) size=(\d+)x(\d+)/);
  if (!m) return null;
  return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
}

// Screen default is 640x480 (SM_CXSCREEN/CYSCREEN).
const SCREEN_W = 640, SCREEN_H = 480;

async function countNonGrey(p, bbox) {
  const img = await loadImage(p);
  const cv = createCanvas(img.width, img.height);
  cv.getContext('2d').drawImage(img, 0, 0);
  const data = cv.getContext('2d').getImageData(0, 0, img.width, img.height).data;
  let n = 0;
  for (let y = bbox.y0; y < Math.min(bbox.y1, img.height); y++) {
    for (let x = bbox.x0; x < Math.min(bbox.x1, img.width); x++) {
      const i = (y * img.width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      // Skip grey frame (0xc0) and teal desktop (0x008080).
      const isGrey = (r === 0xC0 && g === 0xC0 && b === 0xC0);
      const isTeal = (r === 0x00 && g === 0x80 && b === 0x80);
      if (!isGrey && !isTeal) n++;
    }
  }
  return n;
}

(async () => {
  // After maximize, the solitaire green felt + cards should extend into
  // the lower-right quadrant. If the app never got WM_SIZE, that area
  // stays empty (grey frame).
  const LR = { x0: 400, y0: 300, x1: 620, y1: 460 };
  let lrBefore = -1, lrAfter = -1;
  if (fs.existsSync(beforePng) && fs.existsSync(afterPng)) {
    lrBefore = await countNonGrey(beforePng, LR);
    lrAfter  = await countNonGrey(afterPng,  LR);
  }

  const geomMaximized = lastRect &&
    lastRect.x === 0 && lastRect.y === 0 &&
    lastRect.w >= SCREEN_W && lastRect.h >= SCREEN_H;

  const contentRelaid = lrAfter > lrBefore + 500;

  const hasUnimpl = /UNIMPLEMENTED API:/.test(out);

  const checks = [
    { name: 'Solitaire launched (window created)',     pass: !!firstRect },
    { name: 'renderer geom = full screen post-click',  pass: !!geomMaximized },
    { name: 'content relaid into new lower-right area',pass: contentRelaid },
    { name: 'no UNIMPLEMENTED API crash',              pass: !hasUnimpl },
  ];

  console.log('');
  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log(`first rect: ${JSON.stringify(firstRect)}`);
  console.log(`last  rect: ${JSON.stringify(lastRect)}`);
  console.log(`lower-right non-grey px: before=${lrBefore} after=${lrAfter}`);
  console.log('');
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
})();
