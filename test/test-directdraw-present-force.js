#!/usr/bin/env node

'use strict';

// The DirectDraw present path has one contract that both hosts depend on and
// that nothing else covered:
//
//   presentBestDxOffscreen's change detector is a SAMPLE, not a compare. It
//   hashes one byte every (pitch >>> 2) bytes -- four bytes per row on a 640x480
//   8bpp primary -- so a sprite that moves between those columns changes no
//   sampled byte and the upload is skipped. force=true is the only way to get
//   the real pixels onto the canvas, which is why host.js (2a611396) and
//   test/run.js (e4ba1b3b) both pass it once the guest says a frame is done.
//
// Lose the force flag and a DX game goes back to showing stale frames while
// every existing test still passes, because they all change sampled bytes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Canvas } = require('../lib/canvas-compat');
const { createHostImports } = require('../lib/host-imports');

const W = 64;
const H = 8;
const PITCH = W;              // 8bpp, so step = PITCH >>> 2 = 16 sampled bytes
const STEP = PITCH >>> 2;
const memory = new ArrayBuffer(128 * 1024 * 1024);
const bytes = new Uint8Array(memory);
const dv = new DataView(memory);
const slot = 3;
const entry = 0x07FF0000 + slot * 32;
const bits = 0x20000;
const hwnd = 0x77;
const canvas = new Canvas(W, H);

dv.setUint32(entry, 2, true);        // DDSurface
dv.setUint16(entry + 12, W, true);
dv.setUint16(entry + 14, H, true);
dv.setUint16(entry + 16, 8, true);   // bpp
dv.setUint16(entry + 18, PITCH, true);
dv.setUint32(entry + 20, bits, true);
dv.setUint32(entry + 28, 1, true);   // primary

// A greyscale palette, so a pixel value reads back as its own colour index.
const palWa = 0x30000;
for (let i = 0; i < 256; i++) {
  bytes[palWa + i * 4] = i;
  bytes[palWa + i * 4 + 1] = i;
  bytes[palWa + i * 4 + 2] = i;
}

const renderer = {
  windows: { [hwnd]: {} },
  getWindowCanvas() { return { ctx: canvas.getContext('2d') }; },
  scheduleRepaint() {},
};
const { gdi } = createHostImports({
  getMemory: () => memory,
  exports: {
    get_main_hwnd: () => hwnd,
    get_dx_primary_pal_wa: () => palWa,
  },
  renderer,
});

const presentedPixel = (x, y) => {
  const layer = renderer.windows[hwnd]._dxFrameLayer;
  assert(layer, 'a presented primary must own a DX frame layer');
  return Array.from(layer.canvas.getContext('2d').getImageData(x, y, 1, 1).data);
};

// Establish the baseline signature the way a first frame would. A surface with
// no non-zero byte anywhere counts as never painted and is skipped, so give the
// background a value first -- at a sampled offset, so it is the baseline and not
// the change under test.
bytes[bits] = 0x20;
assert.strictEqual(gdi.presentBestDxOffscreen(), 1, 'the first frame must upload');

// Draw a "sprite" strictly between the sampled columns. Column 5 of row 3 is
// not a multiple of STEP, and neither is the surface's final byte, so the
// sampled set is byte-for-byte identical to the frame already presented.
const spriteX = 5;
const spriteY = 3;
const spriteOff = spriteY * PITCH + spriteX;
assert.notStrictEqual(spriteOff % STEP, 0, 'the probe must miss the sampled columns');
bytes[bits + spriteOff] = 0xC8;

assert.strictEqual(gdi.presentBestDxOffscreen(), 0,
  'documents the bug being guarded: the sampled signature cannot see this frame');
assert.deepStrictEqual(presentedPixel(spriteX, spriteY), [0, 0, 0, 255],
  'the unforced path really did leave the canvas stale');

assert.strictEqual(gdi.presentBestDxOffscreen(true), 1,
  'force=true must upload a frame the signature calls unchanged');
assert.deepStrictEqual(presentedPixel(spriteX, spriteY), [0xC8, 0xC8, 0xC8, 255],
  'the forced upload must carry the pixels the signature missed');

// Forcing must not corrupt the dedup state for callers that still want it.
assert.strictEqual(gdi.presentBestDxOffscreen(), 0,
  'a forced upload must record its signature so an unchanged follow-up is dropped');

// Both hosts must actually use it. There is no headless way to observe host.js's
// requestAnimationFrame coalescing, so pin the two properties that a revert
// would take out: the poll is gone, and the present is forced. Narrow on
// purpose -- these assert the shape of the call, not the timing.
const ROOT = path.join(__dirname, '..');
for (const file of ['host.js', 'test/run.js']) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  assert.doesNotMatch(source, /_dxPresentTick|\(batch & 0x7f\) === 0 && base\.gdi/,
    `${file} must not present DirectDraw from a batch/slice poll`);
  assert.match(source, /presentBestDxOffscreen\(true\)/,
    `${file} must force the DirectDraw upload, not trust the sampled signature`);
  assert.match(source, /dx_trace = \(kind/,
    `${file} must drive the DirectDraw present from dx_trace`);
}

console.log('PASS  DirectDraw presents are forced past the sampled signature');
