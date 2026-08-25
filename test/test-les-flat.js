#!/usr/bin/env node
// LES and LDS (0xC4 / 0xC5) are legal in 32-bit protected mode, not just in a
// segmented 16-bit task. The decoder used to route both straight into
// $win16_only, which traps with the 0xCA165E00 marker on the theory that a
// segmented opcode in flat code means the instruction stream is lost.
//
// It isn't lost here: Watcom's va_arg walker emits `les eax, [edx-8]` to pull a
// far pointer off the argument list, and Fallout's demo runs one at 0x4a706a
// while loading its master.dat. That killed the whole emulator ~12800 batches
// in, well before the title screen. In a flat task every selector is flat, so
// the segment half of the load is a value to drop and the offset half is the
// instruction; op 425 does exactly that.
//
// The check is the title screen: the menu plate is the first thing past the
// file-loading code that trapped, so ink on it means the demo got through.
//
//   node test/test-les-flat.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'test', 'binaries', 'candidates', 'fallout-demo',
  'falldemo', 'Falldemo.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  Falldemo.exe not found');
  process.exit(0);
}

const shot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-les-')), 'fallout.png');

// Captured mid-run rather than with --png: the demo drives a DirectDraw
// primary, and the shutdown path this run never reaches leaves the exit-time
// capture empty.
const log = execFileSync('node', [
  path.join(ROOT, 'test', 'run.js'), '--app=fallout_demo', '--no-build', '--no-close',
  '--stuck-after=1000000', '--max-batches=32000', `--input=30000:png:${shot}`,
], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });

// The old failure was a decoder trap, which prints its marker before dying.
assert(!/CA165E00/i.test(log), 'no segmented-opcode trap in flat 32-bit code');
assert(!/CRASH|UNIMPLEMENTED API/.test(log), 'the demo ran to its title screen without crashing');

// The menu plate sits top-right: five riveted bars of yellow-on-dark text.
// Count the yellow -- it is nothing like the desaturated greens and greys the
// rest of the art is made of, so a partial draw cannot fake it.
const png = PNG.sync.read(fs.readFileSync(shot));
let yellow = 0;
for (let y = 40; y < 240 && y < png.height; y++) {
  for (let x = 420; x < 620 && x < png.width; x++) {
    const i = (y * png.width + x) * 4;
    const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
    // #746018 is the label face -- amber, not bright yellow, and much warmer
    // than anything else on the plate.
    if (r > 90 && b < 70 && g > b && r - b > 60) yellow++;
  }
}

assert(yellow > 300, `the menu labels are drawn -- ${yellow} px of label yellow`);
console.log(`PASS  a flat 32-bit task can execute LES (${yellow} px of Fallout menu text)`);
