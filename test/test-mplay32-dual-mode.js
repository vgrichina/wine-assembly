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
  try { fs.unlinkSync(png); } catch (_) {}
  const pickBatch = openBatch + 60;
  const input = [
    `8:vfs-import:PINBALL.MID:${MIDI}`,
    `${openBatch}:wait-title-command:Media_Player:800:100:open`,
    `${pickBatch}:open-dlg-pick:PINBALL.MID`,
    `${pickBatch + 30}:dump-windows:${name}`,
    `${pickBatch + 35}:dump-toolbar:${name}`,
    // Play is command 501 on the transport toolbar. This used to be
    // click:31:79, which stopped landing on the button when the toolbar moved
    // down the window -- 79 is inside MPlayerTrackMap now, so Play was never
    // pressed and "Play reaches MCI" failed while every other check passed.
    `${pickBatch + 40}:toolbar-click:501:play`,
    `${pickBatch + 55}:png:${png}`,
    `${pickBatch + 65}:0x10:0`,
  ].join(',');
  try {
    const output = execFileSync(process.execPath, [
      RUN,
      `--exe=${EXE}`,
      `--dlls=${dlls.join(',')}`,
      `--input=${input}`,
      `--max-batches=${pickBatch + 70}`,
      '--batch-size=1000',
      '--no-close',
      '--quiet-api',
      '--quiet-blocks',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    return { name, output, png, failed: false };
  } catch (error) {
    return {
      name,
      output: `${error.stdout || ''}${error.stderr || ''}`,
      png,
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
  check(`${run.name}: MIDI file opened`, /\[MCI\] open sequencer id=1 element="PINBALL\.MID" notes=14139/.test(run.output));
  check(`${run.name}: stable stopped title rendered`, /title="PINBALL\.MID - Media Player \(stopped\)"/.test(run.output));
  check(`${run.name}: Play reaches MCI`, /\[MCI\] play sequencer id=1 element="PINBALL\.MID" notes=14139/.test(run.output));
  check(`${run.name}: screenshot written`, fs.existsSync(run.png) && fs.statSync(run.png).size > 4000);
  check(`${run.name}: WM_CLOSE exits cleanly`, /\[Exit\] code=0/.test(run.output));
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

const watTrackbarInk = paintedInk(wat.png, trackbarRect(wat.output, 'wat'));
check(`WAT: trackbar uses built-in class and is painted (${watTrackbarInk} colors)`,
  /window:wat[^\n]*class="msctls_trackbar32" ctrlClass=19/.test(wat.output) &&
  watTrackbarInk >= 3);
check('WAT: transport toolbar keeps Play enabled after open',
  /toolbar:wat:[^\n]*#0 ok=1\/1 img=0 cmd=501 state=0x4/.test(wat.output));
check('WAT: toolbar uses Win98 padded 23x22 transport faces',
  /toolbar:wat:[^\n]*#0[^\n]*rect=2,2,25,24/.test(wat.output));
const nativeTrackbarInk = paintedInk(native.png, trackbarRect(native.output, 'native'));
check(`native: loaded comctl32 owns toolbar and trackbar classes (${nativeTrackbarInk} colors)`,
  /window:native[^\n]*class="msctls_trackbar32" ctrlClass=0/.test(native.output) &&
  /window:native[^\n]*class="ToolbarWindow32" ctrlClass=0/.test(native.output) &&
  nativeTrackbarInk >= 3);

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
