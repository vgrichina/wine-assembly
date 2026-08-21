#!/usr/bin/env node

'use strict';

// Paint initially creates its MDI view at full frame height, then docks the
// real status bar over the old view scrollbar. The status control must repaint
// that shared surface instead of exposing the stale arrow buttons and thumb.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = process.env.MSPAINT_EXE || path.join(__dirname, 'binaries', 'mspaint.exe');
const SHOT = path.join(ROOT, 'scratch', 'mspaint-statusbar.png');
const CLEAR_SHOT = path.join(ROOT, 'scratch', 'mspaint-statusbar-clear.png');
const PREVIEW_SHOT = path.join(ROOT, 'scratch', 'mspaint-statusbar-preview.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

try { fs.unlinkSync(SHOT); } catch (_) {}
try { fs.unlinkSync(CLEAR_SHOT); } catch (_) {}
try { fs.unlinkSync(PREVIEW_SHOT); } catch (_) {}

let output = '';
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=20:dump-windows:status,21:mousemove:180:180,23:png:${SHOT},24:mousemove:39:146,26:png:${CLEAR_SHOT},28:0x111:57609,36:png:${PREVIEW_SHOT},37:stop`,
    '--max-batches=45',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  output = `${error.stdout || ''}${error.stderr || ''}`;
  assert.fail(`Paint status-bar run failed:\n${output.slice(-3000)}`);
}

assert(fs.existsSync(SHOT) && fs.statSync(SHOT).size > 0,
  'Paint status-bar screenshot was not written');
assert(fs.existsSync(CLEAR_SHOT) && fs.statSync(CLEAR_SHOT).size > 0,
  'Paint cleared-status screenshot was not written');
assert(fs.existsSync(PREVIEW_SHOT) && fs.statSync(PREVIEW_SHOT).size > 0,
  'Paint preview-status screenshot was not written');
const image = PNG.sync.read(fs.readFileSync(SHOT));
const clearImage = PNG.sync.read(fs.readFileSync(CLEAR_SHOT));
const previewImage = PNG.sync.read(fs.readFileSync(PREVIEW_SHOT));
const statusLine = output.split('\n').find(line =>
  line.includes('window:status') && line.includes('class="msctls_statusbar32"')) || '';
assert(statusLine.includes('ctrlClass=0'),
  `Paint status bar must retain its registered guest wndproc: ${statusLine}`);
// Paint's frame is created with WS_EX_CLIENTEDGE (exStyle 0x300), so its
// client area is inset 2px more per side than a plain frame, and the sizing
// border is 4px rather than the 3 this test was written against. Both are
// what Win98 does; between them the client went from 269x355 to 263x350 and
// the bar with it. The pixel probes below follow: 3px right, 2px up, and the
// grip/right-arrow ones 3px left of where they were.
assert(statusLine.includes('pos=0,327 size=263x23'),
  `Paint status bar did not retain its MFC docked geometry: ${statusLine}`);

// The old stale scrollbar has mirrored black triangular arrows in both 16px
// end boxes. A real status line has prompt glyphs on the left and no arrow in
// the right-side pane before the size grip.
let rightArrowInk = 0;
for (let y = 402; y <= 408; y++) {
  for (let x = 277; x <= 281; x++) {
    const p = (y * image.width + x) * 4;
    if (image.data[p] < 32 && image.data[p + 1] < 32 && image.data[p + 2] < 32) rightArrowInk++;
  }
}

let promptInk = 0;
for (let y = 395; y < 410; y++) {
  for (let x = 30; x < 223; x++) {
    const p = (y * image.width + x) * 4;
    if (image.data[p] < 80 && image.data[p + 1] < 80 && image.data[p + 2] < 80) promptInk++;
  }
}

// Paint's MFC CStatusBar has a fixed help pane followed by a second recessed
// coordinate pane. Its lower-right resize grip is a six-segment 3D staircase,
// not the empty strip produced by treating it as a generic common control.
let paneSeparator = 0;
for (let y = 395; y <= 410; y++) {
  for (let x = 194; x <= 196; x++) {
    const p = (y * image.width + x) * 4;
    if (image.data[p] < 160 && image.data[p + 1] < 160 && image.data[p + 2] < 160) paneSeparator++;
  }
}

let gripShadow = 0;
for (let y = 405; y <= 412; y++) {
  for (let x = 275; x <= 287; x++) {
    // The staircase is drawn in COLOR_3DSHADOW over the face, and on Win98
    // that is exactly 0x808080. This used to accept anything from 32 to 111,
    // which is a darker grey than the palette has ever had here.
    const p = (y * image.width + x) * 4;
    if (image.data[p] === 0x80 && image.data[p + 1] === 0x80 && image.data[p + 2] === 0x80) gripShadow++;
  }
}

let coordinateInk = 0;
let clearedCoordinateInk = 0;
let previewCoordinateInk = 0;
let previewPromptDiff = 0;
for (let y = 397; y <= 408; y++) {
  for (let x = 199; x <= 253; x++) {
    const p = (y * image.width + x) * 4;
    if (image.data[p] < 80 && image.data[p + 1] < 80 && image.data[p + 2] < 80) coordinateInk++;
    if (clearImage.data[p] < 80 && clearImage.data[p + 1] < 80 && clearImage.data[p + 2] < 80) {
      clearedCoordinateInk++;
    }
    if (previewImage.data[p] < 80 && previewImage.data[p + 1] < 80 && previewImage.data[p + 2] < 80) {
      previewCoordinateInk++;
    }
  }
}
for (let y = 397; y <= 408; y++) {
  for (let x = 30; x <= 191; x++) {
    const p = (y * image.width + x) * 4;
    if (previewImage.data[p] !== clearImage.data[p] ||
        previewImage.data[p + 1] !== clearImage.data[p + 1] ||
        previewImage.data[p + 2] !== clearImage.data[p + 2]) previewPromptDiff++;
  }
}

assert(promptInk >= 30, `Paint status prompt did not render (${promptInk} dark pixels)`);
assert(paneSeparator >= 12,
  `Paint status bar is missing its coordinate-pane separator (${paneSeparator} pixels)`);
assert(coordinateInk >= 15,
  `Paint status bar did not render live canvas coordinates (${coordinateInk} pixels)`);
assert(clearedCoordinateInk < 5,
  `Paint status bar retained stale coordinates outside the canvas (${clearedCoordinateInk} pixels)`);
assert(previewCoordinateInk < 5,
  `Paint Print Preview retained stale image coordinates (${previewCoordinateInk} pixels)`);
assert(previewPromptDiff >= 30,
  `Paint Print Preview did not replace the normal status prompt (${previewPromptDiff} pixels)`);
assert(gripShadow >= 12,
  `Paint status bar is missing its Win98 resize grip (${gripShadow} shadow pixels)`);
assert(rightArrowInk < 8,
  `Paint status bar still exposes the stale right scrollbar arrow (${rightArrowInk} pixels)`);
assert(!/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output),
  'Paint status-bar paint triggered an emulator failure');

console.log(`PASS  Paint status bar renders live coordinates and Win98 panes/grip (${promptInk}/${coordinateInk}/${gripShadow} pixels)`);
