#!/usr/bin/env node

'use strict';

// A pinned primary that was never written must not blank the screen.
//
// Once an app explicitly presents a primary surface, the presenter pins that
// slot: a primary is video memory, and CPU writes through a retained Lock
// pointer become visible without another Flip, so we keep signature-checking
// that exact surface (Heroes II's Smacker player depends on it).
//
// But an app can throw its DirectDraw objects away and build new ones. The
// Falling Leaves screensaver does it at every scene change, and the pin then
// named a freshly allocated, still-zeroed primary while the frame the user
// should have been seeing sat in an offscreen surface. We uploaded the empty
// one, and the saver showed a blank screen for thousands of batches at a time
// -- six of eight sampled frames were flat before this rule, two after.
//
// So the pin holds only while the surface has something in it. "Never
// written" is a question about the raw DIB bytes, not about the colours they
// map to: index 0 of an 8bpp palette can be any colour, so a deliberately
// black frame still counts as content and still holds the pin.

const assert = require('assert');
const path = require('path');
const { Canvas } = require('../lib/canvas-compat');
const { createHostImports } = require('../lib/host-imports');

// The chooser only considers offscreen surfaces of at least 320x200 -- below
// that a surface is a sprite or a texture, not a frame.
const hwnd = 0x21;
const W = 320;
const H = 200;

const memory = new ArrayBuffer(128 * 1024 * 1024);
const bytes = new Uint8Array(memory);
const dv = new DataView(memory);
const DX_OBJECTS = 0x07FF0000;

// Greyscale palette, so an 8bpp pixel reads back as its own colour index.
const palWa = 0x30000;
for (let i = 0; i < 256; i++) {
  bytes[palWa + i * 4] = i;
  bytes[palWa + i * 4 + 1] = i;
  bytes[palWa + i * 4 + 2] = i;
}

function makeSurface(slot, bitsWa, flags) {
  const entry = DX_OBJECTS + slot * 32;
  dv.setUint32(entry, 2, true);        // DDSurface
  dv.setUint16(entry + 12, W, true);
  dv.setUint16(entry + 14, H, true);
  dv.setUint16(entry + 16, 8, true);   // bpp
  dv.setUint16(entry + 18, W, true);   // pitch
  dv.setUint32(entry + 20, bitsWa, true);
  dv.setUint32(entry + 28, flags, true);
  return entry;
}

const win = { x: 0, y: 0, w: W, h: H };
const canvas = new Canvas(W, H);
const renderer = {
  windows: { [hwnd]: win },
  getWindowCanvas() { return { ctx: canvas.getContext('2d') }; },
  scheduleRepaint() {},
};

const { host, gdi } = createHostImports({
  getMemory: () => memory,
  exports: {
    get_main_hwnd: () => hwnd,
    get_dx_primary_pal_wa: () => palWa,
    get_dx_exclusive_hwnd: () => 0,
  },
  renderer,
});

const layerPixel = (x, y) => {
  const layer = win._dxFrameLayer;
  assert(layer, 'a presented surface must own a DX frame layer');
  return Array.from(layer.canvas.getContext('2d').getImageData(x, y, 1, 1).data);
};

const primaryBits = 0x40000;
const offscreenBits = 0x50000;
makeSurface(1, primaryBits, 1);   // primary, left zeroed
makeSurface(2, offscreenBits, 4); // offscreen, carrying the frame

// Enough distinct colours that the chooser can tell this is a real frame.
const offPixel = (x, y) => 0x20 + ((x + y) % 100);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) bytes[offscreenBits + y * W + x] = offPixel(x, y);
}

// The app presented the primary once -- that is what pins the slot.
host.dx_trace(5, 1);

assert.strictEqual(gdi.presentBestDxOffscreen(true), 1,
  'something must be presented while the pinned primary is empty');
const grey = v => [v, v, v, 255];
assert.deepStrictEqual(layerPixel(0, 0), grey(offPixel(0, 0)),
  'a never-written pinned primary must not win over a surface with content');
assert.deepStrictEqual(layerPixel(W - 1, H - 1), grey(offPixel(W - 1, H - 1)),
  'and the whole offscreen frame must be uploaded, not just its corner');

// As soon as the primary carries anything at all, the pin holds again --
// including an all-index-0 frame, which is content the app chose.
bytes.fill(0x88, primaryBits, primaryBits + W * H);
assert.strictEqual(gdi.presentBestDxOffscreen(true), 1, 'the written primary must upload');
assert.deepStrictEqual(layerPixel(0, 0), [0x88, 0x88, 0x88, 255],
  'a written primary keeps the pin, whatever the chooser would have preferred');
assert.deepStrictEqual(layerPixel(W - 1, H - 1), [0x88, 0x88, 0x88, 255],
  'across the whole surface');

console.log('PASS  a pinned DirectX primary that was never written does not blank the window');
