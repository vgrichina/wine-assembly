#!/usr/bin/env node
// Winamp 2.91 skin render regression.
//
// Winamp boots, shows the first-run survey dialog, and (once dismissed) loads
// the embedded skin bitmaps via in_mp3's init path. End state: main player at
// 275x116 painted from the sprite sheet, stable in the message loop.
//
// See apps/winamp.md "Current Status: FULLY SKINNED" for the documented run.
//
// PASS criteria:
//   - No UNIMPLEMENTED / unreachable / CRASH in output
//   - Reaches the visible main player and stops through the snapshot helper
//   - Main window (hwnd=65537) exists at 275x116 with title "Winamp 2.91"
//   - Main back-canvas PNG has >100 unique colors (skin bitmap painted, not
//     a blank gray client-area)
//   - API count proves plugin/window startup reached the Winamp UI

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createCanvas, loadImage } = require('../lib/canvas-compat');

const ROOT   = path.join(__dirname, '..');
const RUN    = path.join(__dirname, 'run.js');
const EXE    = path.join(__dirname, 'binaries', 'winamp.exe');
const OUTDIR = path.join(__dirname, 'output');
const PNG    = path.join(OUTDIR, 'winamp.png');
const BACK   = path.join(OUTDIR, 'winamp_back_65537.png');
const MAX_BATCHES = 80;

if (!fs.existsSync(EXE)) {
  console.log('SKIP  winamp.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUTDIR, { recursive: true });
for (const p of [PNG, BACK]) if (fs.existsSync(p)) fs.unlinkSync(p);

// input=10:273:2 dismisses the first-run survey via WM_COMMAND IDCANCEL.
// The wait-title-windows-snapshot helper avoids the slow end-of-run full
// canvas repaint path while still writing per-window back-canvas PNGs.
const cmd = [
  `node "${RUN}"`,
  `--exe="${EXE}"`,
  `--max-batches=${MAX_BATCHES}`,
  '--batch-size=5000',
  '--quiet-api',
  '--quiet-blocks',
  '--buttons=1,1,1,1,1,1,1,1,1,1',
  '--no-close',
  '--stuck-after=5000',
  `--input="10:273:2,11:wait-title-windows-snapshot:Winamp_2.91:1000:winamp:${PNG}"`,
].join(' ');
console.log('$', cmd);

let out = '';
let timedOut = false;
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 60000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  timedOut = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
  console.log(timedOut ? '(run.js timed out — output captured)' : '(run.js exited non-zero — output captured)');
}

const apiMatch = out.match(/Stats:\s+(\d+)\s+API calls,\s+(\d+)\s+batches/);
const apiCount = apiMatch ? parseInt(apiMatch[1], 10) : 0;
const batches  = apiMatch ? parseInt(apiMatch[2], 10) : 0;

const mainMatch = out.match(/hwnd=65537\s+pos=(-?\d+),(-?\d+)\s+size=(\d+)x(\d+)\s+client=\{"x":(-?\d+),"y":(-?\d+),"w":(\d+),"h":(\d+)\}[^\n]*title="([^"]*)"/);
const mainX     = mainMatch ? parseInt(mainMatch[1], 10) : 0;
const mainY     = mainMatch ? parseInt(mainMatch[2], 10) : 0;
const mainW     = mainMatch ? parseInt(mainMatch[3], 10) : 0;
const mainH     = mainMatch ? parseInt(mainMatch[4], 10) : 0;
const mainClientX = mainMatch ? parseInt(mainMatch[5], 10) : 0;
const mainClientY = mainMatch ? parseInt(mainMatch[6], 10) : 0;
const mainClientW = mainMatch ? parseInt(mainMatch[7], 10) : 0;
const mainClientH = mainMatch ? parseInt(mainMatch[8], 10) : 0;
const mainTitle = mainMatch ? mainMatch[9] : '';
const windowRows = Array.from(out.matchAll(/hwnd=(\d+)\s+pos=(-?\d+),(-?\d+)\s+size=(\d+)x(\d+)\s+client=\{"x":(-?\d+),"y":(-?\d+),"w":(\d+),"h":(\d+)\}[^\n]*visible=(true|false)[^\n]*title="([^"]*)"/g))
  .map(m => ({
    hwnd: parseInt(m[1], 10),
    x: parseInt(m[2], 10),
    y: parseInt(m[3], 10),
    w: parseInt(m[4], 10),
    h: parseInt(m[5], 10),
    clientX: parseInt(m[6], 10),
    clientY: parseInt(m[7], 10),
    clientW: parseInt(m[8], 10),
    clientH: parseInt(m[9], 10),
    visible: m[10] === 'true',
    title: m[11],
  }));

const eqWindow = windowRows.find(w => w.visible && w.title === 'Winamp Equalizer');
const playlistWindow = windowRows.find(w => w.visible && w.title === 'Winamp Playlist Editor');

async function backCanvasColors() {
  return imageColorCount(BACK);
}

async function imageColorCount(file) {
  if (!fs.existsSync(file)) return 0;
  const img = await loadImage(file);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  const s = new Set();
  for (let i = 0; i < d.length; i += 4) s.add((d[i] << 16) | (d[i+1] << 8) | d[i+2]);
  return s.size;
}

async function windowBackCanvasColors(win) {
  if (!win) return 0;
  return imageColorCount(path.join(OUTDIR, `winamp_back_${win.hwnd}.png`));
}

async function compositedGrayPixelsBelowMain() {
  if (!fs.existsSync(PNG) || !mainMatch) return 0;
  const img = await loadImage(PNG);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const x = Math.max(0, mainX);
  const y = Math.max(0, mainY + mainH);
  const w = Math.max(0, Math.min(mainW, img.width - x));
  const h = Math.max(0, Math.min(mainH * 2, img.height - y));
  if (w <= 0 || h <= 0) return 0;
  const d = ctx.getImageData(x, y, w, h).data;
  let gray = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (Math.abs(r - 192) <= 2 && Math.abs(g - 192) <= 2 && Math.abs(b - 192) <= 2) gray++;
  }
  return gray;
}

async function topCaptionBluePixels() {
  if (!fs.existsSync(BACK)) return 0;
  const img = await loadImage(BACK);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const h = Math.min(24, img.height);
  const d = ctx.getImageData(0, 0, img.width, h).data;
  let blue = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r < 60 && g > 40 && b > 100) blue++;
  }
  return blue;
}

async function compositedWin98CaptionPixels() {
  if (!fs.existsSync(PNG) || !mainMatch) return 0;
  const img = await loadImage(PNG);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const x = Math.max(0, mainX);
  const y = Math.max(0, mainY);
  const w = Math.max(0, Math.min(mainW, img.width - x));
  const h = Math.max(0, Math.min(18, img.height - y));
  if (w <= 0 || h <= 0) return 0;
  const d = ctx.getImageData(x, y, w, h).data;
  let blue = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r < 40 && g < 50 && b > 100) blue++;
  }
  return blue;
}

async function maxDuplicateTitlebarPixels() {
  if (!fs.existsSync(BACK)) return 0;
  const img = await loadImage(BACK);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const w = Math.min(275, img.width);
  const h = Math.min(14, img.height);
  const top = ctx.getImageData(0, 0, w, h).data;
  let maxSame = 0;
  for (let y = 14; y <= 24 && y + h <= img.height; y++) {
    const row = ctx.getImageData(0, y, w, h).data;
    let same = 0;
    for (let i = 0; i < top.length; i += 4) {
      if (top[i] === row[i] && top[i + 1] === row[i + 1] &&
          top[i + 2] === row[i + 2] && top[i + 3] === row[i + 3]) {
        same++;
      }
    }
    if (same > maxSame) maxSame = same;
  }
  return maxSame;
}

async function compositedMainMismatchPixels() {
  if (!fs.existsSync(PNG) || !fs.existsSync(BACK) || !mainMatch) return Number.MAX_SAFE_INTEGER;
  const screen = await loadImage(PNG);
  const back = await loadImage(BACK);
  const sw = createCanvas(screen.width, screen.height);
  const bw = createCanvas(back.width, back.height);
  const sctx = sw.getContext('2d');
  const bctx = bw.getContext('2d');
  sctx.drawImage(screen, 0, 0);
  bctx.drawImage(back, 0, 0);
  const x = mainX | 0;
  const y = mainY | 0;
  const w = Math.min(back.width, Math.max(0, screen.width - x));
  const h = Math.min(back.height, Math.max(0, screen.height - y));
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return Number.MAX_SAFE_INTEGER;
  const sd = sctx.getImageData(x, y, w, h).data;
  const bd = bctx.getImageData(0, 0, w, h).data;
  let mismatch = 0;
  for (let i = 0; i < sd.length; i += 4) {
    if (sd[i] !== bd[i] || sd[i + 1] !== bd[i + 1] ||
        sd[i + 2] !== bd[i + 2] || sd[i + 3] !== bd[i + 3]) {
      mismatch++;
    }
  }
  return mismatch;
}

(async () => {
  const colors = await backCanvasColors();
  const captionBlue = await topCaptionBluePixels();
  const duplicateTitlebarPixels = await maxDuplicateTitlebarPixels();

  const checks = [
    { name: 'run completed without timeout',    pass: !timedOut },
    { name: 'no UNIMPLEMENTED API crash',       pass: !/UNIMPLEMENTED API:/.test(out) },
    { name: 'no unreachable trap',              pass: !/RuntimeError:\s*unreachable/.test(out) },
    { name: 'snapshot helper stopped the run',  pass: /\[input\] stop at batch/.test(out) },
    { name: 'API count > 2500',                 pass: apiCount > 2500 },
    { name: 'main hwnd 65537 reported',         pass: !!mainMatch },
    { name: 'main window is 275x116',           pass: mainW === 275 && mainH === 116 },
    { name: 'regioned main window client matches full skin surface', pass: mainClientX === mainX && mainClientY === mainY && mainClientW === mainW && mainClientH === mainH },
    { name: 'main title is "Winamp 2.91"',      pass: mainTitle === 'Winamp 2.91' },
    { name: 'main back-canvas PNG exists',      pass: fs.existsSync(BACK) },
    { name: 'main back-canvas has >100 colors', pass: colors > 100 },
    { name: 'no standard blue titlebar over skin', pass: captionBlue === 0 },
    { name: 'equalizer window is visible', pass: !!eqWindow },
    { name: 'playlist window is visible', pass: !!playlistWindow },
    { name: 'top titlebar was not blitted again lower in main window', pass: duplicateTitlebarPixels < 200 },
  ];

  console.log('');
  console.log(`  apiCount=${apiCount} batches=${batches} mainSize=${mainW}x${mainH} mainClient=${mainClientX},${mainClientY},${mainClientW}x${mainClientH} title="${mainTitle}" backColors=${colors} duplicateTitlebarPixels=${duplicateTitlebarPixels}`);
  console.log('');
  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log('');
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
})();
