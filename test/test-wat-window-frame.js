#!/usr/bin/env node

// A top-level window's sizing frame, pixel for pixel.
//
// Ground truth is real Windows 98 running under v86 (see
// tools/v86-reference/shell-apps.json), probed with
// `node tools/png-crop.js <shot> --probe=X,Y,W,H`. A WS_THICKFRAME window
// there is SM_CXFRAME = 4 pixels on every side and reads
//
//   top / left,  outward in:   3DFACE, 3DHILIGHT, 3DFACE, 3DFACE
//   bottom / right, inward out: 3DFACE, 3DFACE, 3DSHADOW, 3DDKSHADOW
//
// with the caption starting at (4, 4). We drew a 3-pixel frame whose highlight
// sat on the outermost row, which put every window's border one pixel thin and
// inverted at the top-left corner.
//
// Notepad is the subject because it is the cheapest app that reaches a painted
// top-level window, and it carries WS_THICKFRAME.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'notepad.exe');
const OUT = path.join(ROOT, 'scratch', 'window-frame.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  notepad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
try { fs.unlinkSync(OUT); } catch (_) {}

const output = execFileSync(process.execPath, [
  RUN,
  `--exe=${EXE}`,
  `--input=20:dump-windows:frame,20:png:${OUT}`,
  '--max-batches=30',
  '--quiet-api',
  '--quiet-blocks',
], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });

const line = output.split('\n').find(l => l.includes('window:frame hwnd=65537')) || '';
assert(line, 'notepad did not report its top-level window');
const pos = line.match(/pos=(-?\d+),(-?\d+)/);
const size = line.match(/size=(\d+)x(\d+)/);
const style = line.match(/style=0x([0-9a-f]+)/);
assert(pos && size && style, `could not parse window geometry from: ${line}`);
const x = Number(pos[1]);
const y = Number(pos[2]);
const w = Number(size[1]);
const h = Number(size[2]);
assert(parseInt(style[1], 16) & 0x00040000, 'notepad window is not WS_THICKFRAME');

const image = PNG.sync.read(fs.readFileSync(OUT));
const at = (px, py) => {
  const i = (py * image.width + px) * 4;
  return (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2];
};
const FACE = 0xC0C0C0;
const HILIGHT = 0xFFFFFF;
const SHADOW = 0x808080;
const DKSHADOW = 0x000000;
const name = c => ({
  [FACE]: '3DFACE', [HILIGHT]: '3DHILIGHT', [SHADOW]: '3DSHADOW', [DKSHADOW]: '3DDKSHADOW',
}[c] || `#${c.toString(16).padStart(6, '0')}`);

let passed = 0;
let failed = 0;
const check = (label, got, want) => {
  if (got === want) {
    passed += 1;
    console.log(`PASS  ${label} is ${name(want)}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label} is ${name(got)}, want ${name(want)}`);
  }
};

// Sample the borders away from the corners, where the two edges meet and
// either color is defensible.
const midX = x + Math.floor(w / 2);
const midY = y + Math.floor(h / 2);
const TOP_LEFT = [FACE, HILIGHT, FACE, FACE];
const BOTTOM_RIGHT = [FACE, FACE, SHADOW, DKSHADOW];

TOP_LEFT.forEach((want, i) => check(`top border row ${i}`, at(midX, y + i), want));
TOP_LEFT.forEach((want, i) => check(`left border column ${i}`, at(x + i, midY), want));
BOTTOM_RIGHT.forEach((want, i) => {
  check(`bottom border row ${i - 4}`, at(midX, y + h - 4 + i), want);
});
BOTTOM_RIGHT.forEach((want, i) => {
  check(`right border column ${i - 4}`, at(x + w - 4 + i, midY), want);
});

// The caption begins immediately inside the frame. Its gradient starts at the
// Win98 active-caption navy, so the test names the color rather than merely
// asserting "not frame-colored" — a frame that ate the first caption row would
// otherwise pass.
// Sampled at the caption's first column, where the gradient has not yet
// stepped away from its start color.
const captionTop = at(x + 4, y + 4);
if (captionTop === 0x000080) {
  passed += 1;
  console.log('PASS  caption starts at (4,4) with ACTIVECAPTION');
} else {
  failed += 1;
  console.log(`FAIL  caption at (4,4) is ${name(captionTop)}, want ACTIVECAPTION #000080`);
}
// One row higher must still be frame, or the caption has crept outward.
check('row above the caption', at(x + 4, y + 3), FACE);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
