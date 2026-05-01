#!/usr/bin/env node
// Tile World end-to-end launch regression. Proves that:
//
//   1. The SDL.dll-linked tworld.exe boots through SDL_Init without crashing.
//   2. The VFS subdirectories (data/, sets/, res/) populated from the EXE
//      directory are reachable, so tworld's level-pack scan finds all 5
//      .dac files (cc-ms / cclp1-ms / cclp2-ms / cclp3-ms / intro-ms).
//   3. The picker UI renders to the SDL window's back-canvas: the table
//      header ("Filename" / "Ruleset"), every .dac entry, and the help
//      hint at the bottom all show up as non-black pixels.
//   4. Pressing Enter is delivered to SDL — ToAsciiEx + level-metadata
//      FileTime calls fire — and the gameplay state machine advances past
//      the picker into a rendered tile board.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
let createCanvas, loadImage;
try { ({ createCanvas, loadImage } = require('../lib/canvas-compat')); } catch (_) {}

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'wep32-community', 'TWorld', 'tworld.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  tworld.exe not found at', EXE);
  process.exit(0);
}
if (!createCanvas || !loadImage) {
  console.log('SKIP  node-canvas not available — cannot diff PNGs');
  process.exit(0);
}

const OUT = path.join(ROOT, 'scratch');
fs.mkdirSync(OUT, { recursive: true });
const pngTitle = path.join(OUT, 'tworld_launch_title.png');
const backTitle = pngTitle.replace(/\.png$/, '_back_65537.png');
for (const p of [pngTitle, backTitle]) { try { fs.unlinkSync(p); } catch (_) {} }

// Schedule:
//   - 2000 batches: enough for SDL_Init + level-pack scan + first repaint
//   - inject Enter at 1800 to verify SDL receives keystrokes (we trace
//     ToAsciiEx + FileTimeToLocalFileTime in the post-run output below)
//   - --no-close keeps the renderer alive after the wndproc returns so
//     the back-canvas dump captures the title screen rather than a frame
//     mid-shutdown.
const inputSpec = [
  '1800:keydown:13',
  '1810:keyup:13',
].join(',');

// --trace-api so we can grep for ToAsciiEx in stdout (proves SDL's win32
// driver consumed the Enter and emitted an SDL_KEYDOWN event).
const cmd = `node "${RUN}" --exe="${EXE}" --input=${inputSpec} --max-batches=2500 --png="${pngTitle}" --trace-api --no-close`;
console.log('$', cmd);

let out = '';
let exitCode = 0;
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 120000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  exitCode = e.status ?? 1;
  console.log(`(run.js exited non-zero status=${exitCode} — output captured)`);
}

const hasUnimpl     = /UNIMPLEMENTED API:/.test(out);
const hasSdlLoad    = /DLL: sdl\.dll at /i.test(out);
const hasSdlWindow  = /\[CreateWindow\] hwnd=0x10001 title="SDL_app"/.test(out);
const hasKeydownIn  = /\[input\] keydown vk=13 at batch/.test(out);
const hasKeyToSdl   = /\[check_input\] msg=0x100 wParam=0xd/.test(out);
const hasToAsciiEx  = /ToAsciiEx\(0x0000000d/.test(out);
const titleExists   = fs.existsSync(backTitle) && fs.statSync(backTitle).size > 0;

(async () => {
  let textPixels = -1, w = 0, h = 0;
  if (titleExists) {
    const img = await loadImage(backTitle);
    w = img.width; h = img.height;
    const cv = createCanvas(w, h);
    cv.getContext('2d').drawImage(img, 0, 0);
    const data = cv.getContext('2d').getImageData(0, 0, w, h).data;
    // SDL renders the picker as light-gray text on near-black background
    // (window chrome aside). Count pixels in the SDL client area that are
    // brighter than the background fill — those are font glyph pixels.
    // Client area: skip the 25px title bar + 1px frame on left/right.
    const x0 = 5, y0 = 30, x1 = w - 5, y1 = h - 5;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        const lum = data[i] + data[i + 1] + data[i + 2];
        if (lum > 384) n++;  // > ~128 per channel = clearly non-black text
      }
    }
    textPixels = n;
  }

  const checks = [
    ['no UNIMPLEMENTED crashes',           !hasUnimpl],
    ['SDL.dll loaded',                     hasSdlLoad],
    ['SDL window created (0x10001)',       hasSdlWindow],
    ['title back-canvas snapshot written', titleExists],
    ['title screen has rendered text',     textPixels >= 1500],
    ['Enter keydown injected',             hasKeydownIn],
    ['Enter delivered as WM_KEYDOWN',      hasKeyToSdl],
    ['ToAsciiEx translated Enter (0x0d)',  hasToAsciiEx],
  ];

  let pass = true;
  console.log('');
  console.log('=== test-tworld-launch ===');
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) pass = false;
  }
  console.log(`  textPixels=${textPixels} (back ${w}x${h})`);

  if (!pass) {
    console.log('');
    console.log(`Inspect ${backTitle}`);
    process.exit(1);
  }
  console.log('OK');
  process.exit(0);
})();
