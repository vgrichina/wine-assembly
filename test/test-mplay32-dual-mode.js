#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'mplay32.exe');
const MSVCRT = path.join(__dirname, 'binaries', 'dlls', 'msvcrt.dll');
const COMCTL32 = path.join(__dirname, 'binaries', 'dlls', 'comctl32.dll');
const MIDI = path.join(__dirname, 'binaries', 'pinball', 'PINBALL.MID');
const OUT = path.join(ROOT, 'scratch', 'mplay32-dual-mode');

for (const file of [EXE, MSVCRT, COMCTL32, MIDI]) {
  if (!fs.existsSync(file)) {
    console.log('SKIP  missing fixture:', file);
    process.exit(0);
  }
}
fs.mkdirSync(OUT, { recursive: true });

function runMode(name, dlls, openBatch) {
  const png = path.join(OUT, `${name}.png`);
  const startupPng = path.join(OUT, `${name}-startup.png`);
  try { fs.unlinkSync(png); } catch (_) {}
  try { fs.unlinkSync(startupPng); } catch (_) {}
  const pickBatch = openBatch + 60;
  const playBatch = pickBatch + 30;
  const screenshotBatch = playBatch + 20;
  const helpBatch = screenshotBatch + 10;
  const exitBatch = helpBatch + 7;
  const playInput = name === 'wat'
    ? [`${playBatch}:mousedown:39:123`, `${playBatch + 5}:mouseup:39:123`]
    : [`${playBatch}:toolbar-click:501:play`];
  const input = [
    `8:vfs-import:PINBALL.MID:${MIDI}`,
    `${openBatch - 20}:png:${startupPng}`,
    // Exercise the real parsed menu: Alt+F opens File, Down selects the first
    // row, and Enter activates Open. Successful file-dialog creation and MIDI
    // loading below prove the menu delivered command 100 to Media Player.
    `${openBatch}:wait-title-menu-open:Media_Player:800:70:${name}-file-open`,
    `${openBatch + 2}:menu-dump:${name}-file-open`,
    `${openBatch + 4}:keydown:40`,
    `${openBatch + 6}:keydown:13`,
    `${pickBatch}:open-dlg-pick:PINBALL.MID`,
    // Play is command 501 on the transport toolbar. This used to be
    // click:31:79, which stopped landing on the button when the toolbar moved
    // down the window -- 79 is inside MPlayerTrackMap now, so Play was never
    // pressed and "Play reaches MCI" failed while every other check passed.
    // The WAT toolbar needs the same time between DOWN and UP as real browser
    // events. Native comctl32 resolves the command-based helper to its actual
    // button rectangle, then performs the equivalent native-control click.
    ...playInput,
    `${screenshotBatch}:png:${png}`,
    // Introspection sends synchronous control messages. Keep it after the
    // user click so it cannot perturb focus/capture before playback starts.
    `${screenshotBatch + 2}:dump-windows:${name}`,
    `${screenshotBatch + 4}:dump-toolbar:${name}`,
    // Re-open another real menu after playback has begun. This catches menu
    // state getting stuck after a toolbar click or nested MCI dispatch.
    `${helpBatch}:wait-title-menu-open:Media_Player:800:72:${name}-help-playing`,
    `${helpBatch + 2}:menu-dump:${name}-help-playing`,
    // Finish through File > Exit instead of injecting WM_CLOSE. Besides being
    // user-realistic, this proves a second File-menu command still dispatches.
    `${exitBatch}:wait-title-menu-open:Media_Player:800:70:${name}-file-exit`,
    `${exitBatch + 2}:menu-dump:${name}-file-exit`,
    `${exitBatch + 4}:keydown:40`,
    `${exitBatch + 6}:keydown:40`,
    `${exitBatch + 8}:keydown:40`,
    `${exitBatch + 10}:keydown:13`,
  ].join(',');
  try {
    const output = execFileSync(process.execPath, [
      RUN,
      `--exe=${EXE}`,
      `--dlls=${dlls.join(',')}`,
      `--input=${input}`,
      `--max-batches=${exitBatch + 20}`,
      '--batch-size=1000',
      '--no-close',
      '--quiet-api',
      '--quiet-blocks',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    return { name, output, png, startupPng, failed: false };
  } catch (error) {
    return {
      name,
      output: `${error.stdout || ''}${error.stderr || ''}`,
      png,
      startupPng,
      failed: true,
    };
  }
}

const wat = runMode('wat', [MSVCRT], 140);
const native = runMode('native', [MSVCRT, COMCTL32], 160);
const runs = [wat, native];
const checks = [];
const check = (name, pass) => checks.push([name, !!pass]);

for (const run of runs) {
  check(`${run.name}: emulator run completed`, !run.failed);
  check(`${run.name}: File menu exposes Open, Close, and Exit`,
    new RegExp(`menu-dump:${run.name}-file-open:[^\\n]*&Open\\.\\.[^\\n]*&Close[^\\n]*E&xit`).test(run.output));
  check(`${run.name}: MIDI file opened`, /\[MCI\] open sequencer id=1 element="PINBALL\.MID" notes=14139/.test(run.output));
  check(`${run.name}: stable stopped title rendered`, /title="PINBALL\.MID - Media Player \(stopped\)"/.test(run.output));
  check(`${run.name}: Play reaches MCI`, /\[MCI\] play sequencer id=1 element="PINBALL\.MID" notes=14139/.test(run.output));
  check(`${run.name}: Help menu remains usable during playback`,
    new RegExp(`menu-dump:${run.name}-help-playing:[^\\n]*&Help Topics[^\\n]*&About Media Player`).test(run.output));
  check(`${run.name}: screenshot written`, fs.existsSync(run.png) && fs.statSync(run.png).size > 4000);
  check(`${run.name}: File > Exit exits cleanly`, /\[Exit\] code=0/.test(run.output));
  check(`${run.name}: no runtime crash`, !/UNIMPLEMENTED API:|RuntimeError|LinkError|\*\*\* CRASH|STUCK at EIP/.test(run.output));
}

// Does the trackbar actually have pixels on screen? This used to assert
// hasBack=true on the trackbar window, but a back-canvas is not the same
// question as "is it painted", and the answer changed for architectural
// reasons rather than visual ones: back-canvases are allocated per *top-level*
// hwnd, and children composite into their parent's surface instead of owning
// one (see the rendering-surfaces note in CLAUDE.md, which says in as many
// words not to add a second drawing surface). Every child window in every dump
// now reports hasBack=false. So measure the pixels, not the allocation.
function paintedInk(pngPath, rect) {
  if (!rect || !fs.existsSync(pngPath)) return 0;
  const img = PNG.sync.read(fs.readFileSync(pngPath));
  const seen = new Set();
  for (let y = rect.y; y < rect.y + rect.h && y < img.height; y++) {
    for (let x = rect.x; x < rect.x + rect.w && x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      seen.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]);
    }
  }
  return seen.size;
}

function trackbarRect(output, name) {
  const line = output.split('\n').find(l =>
    l.includes(`window:${name} `) && l.includes('class="msctls_trackbar32"'));
  const m = line && line.match(/client=\{"x":(-?\d+),"y":(-?\d+),"w":(\d+),"h":(\d+)\}/);
  return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null;
}

function toolbarRect(output, name, controlId) {
  const line = output.split('\n').find(l =>
    l.includes(`window:${name} `) && l.includes('class="ToolbarWindow32"') &&
    l.includes(`ctrlId=${controlId} `));
  const m = line && line.match(/client=\{"x":(-?\d+),"y":(-?\d+),"w":(\d+),"h":(\d+)\}/);
  return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null;
}

// At startup every transport command is disabled. Native comctl32 draws each
// disabled glyph as a white highlight plus a gray shadow over COLOR_BTNFACE.
// The old indexed-DIB mask bug instead filled the entire 16x16 icon interior
// with COLOR_BTNSHADOW, which looked like a row of blank dark rectangles.
function disabledTransportGlyphsVisible(pngPath, rect) {
  if (!rect || !fs.existsSync(pngPath)) return false;
  const img = PNG.sync.read(fs.readFileSync(pngPath));
  for (let button = 0; button < 3; button++) {
    let face = 0;
    let highlight = 0;
    const left = rect.x + 3 + button * 23;
    const top = rect.y + 4;
    for (let y = top; y < top + 16; y++) {
      for (let x = left; x < left + 16; x++) {
        const i = (y * img.width + x) * 4;
        const color = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
        if (color === 0xC0C0C0) face++;
        if (color === 0xFFFFFF) highlight++;
      }
    }
    if (face < 100 || highlight < 5) return false;
  }
  return true;
}

const watTrackbarInk = paintedInk(wat.png, trackbarRect(wat.output, 'wat'));
check(`WAT: trackbar uses built-in class and is painted (${watTrackbarInk} colors)`,
  /window:wat[^\n]*class="msctls_trackbar32" ctrlClass=19/.test(wat.output) &&
  watTrackbarInk >= 3);
check('WAT: transport toolbar keeps Play enabled after open',
  /toolbar:wat:[^\n]*#0 ok=1\/1 img=0 cmd=501 state=0x4/.test(wat.output));
check('WAT: toolbar uses Win98 padded 23x22 transport faces',
  /toolbar:wat:[^\n]*#0[^\n]*rect=2,2,25,24/.test(wat.output));
check('WAT: named LoadMenuW attaches the Media Player menu bar',
  /window:wat[^\n]*class="MPlayer"[^\n]*menuBar=true/.test(wat.output));
const nativeTrackbarInk = paintedInk(native.png, trackbarRect(native.output, 'native'));
check(`native: loaded comctl32 owns toolbar and trackbar classes (${nativeTrackbarInk} colors)`,
  /window:native[^\n]*class="msctls_trackbar32" ctrlClass=0/.test(native.output) &&
  /window:native[^\n]*class="ToolbarWindow32" ctrlClass=0/.test(native.output) &&
  nativeTrackbarInk >= 3);
check('native: disabled startup transport glyphs are embossed, not solid rectangles',
  disabledTransportGlyphsVisible(native.startupPng, toolbarRect(native.output, 'native', 301)));
check('native: named LoadMenuW attaches the Media Player menu bar',
  /window:native[^\n]*class="MPlayer"[^\n]*menuBar=true/.test(native.output));

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) failed++;
}
if (failed) {
  for (const run of runs) console.error(`\n--- ${run.name} tail ---\n${run.output.slice(-5000)}`);
}
console.log(`Screenshots: ${OUT}`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
