#!/usr/bin/env node

'use strict';

// Where a presented DirectX frame lands inside its window.
//
// The frame goes onto a per-window layer that the compositor draws at the
// window origin, so everything here is window-local. Two kinds of surface
// arrive and they do NOT share a coordinate system:
//
//   * a DirectDraw primary IS the screen -- surface (0,0) is screen (0,0),
//     and only the part under the client rect belongs to the app;
//   * a windowed Direct3D9 render target is its device window's client area
//     -- surface (0,0) is that window's client origin.
//
// Both were once treated as the first kind, and the clip rect was built by
// adding the window origin to a clientRect that already carried it. Pawn
// showed both bugs at once: at 640x480 the doubled offset ran the clip off
// the right edge of the primary, the width clamped to zero, and the whole
// surface was blitted at the window origin over the caption and menu; at
// 1024x768 the clip landed at 704,242 and painted a black rectangle beside
// the board.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Canvas } = require('../lib/canvas-compat');
const { createHostImports } = require('../lib/host-imports');

const ROOT = path.join(__dirname, '..');
const hwnd = 0x77;
const deviceChild = 0x99;

// A 28x12 window at (10,4) whose client area is 20x5 at screen (14,9): four
// pixels of border on the left, five rows of caption and menu on top.
const WIN = { x: 10, y: 4, w: 28, h: 12 };
const CLIENT = { x: 14, y: 9, w: 20, h: 5 };
const DEST_X = CLIENT.x - WIN.x;   // 4
const DEST_Y = CLIENT.y - WIN.y;   // 5

const memory = new ArrayBuffer(128 * 1024 * 1024);
const bytes = new Uint8Array(memory);
const dv = new DataView(memory);
const DX_OBJECTS = 0x07F60000;

// A greyscale palette, so an 8bpp pixel reads back as its own colour index.
const palWa = 0x30000;
for (let i = 0; i < 256; i++) {
  bytes[palWa + i * 4] = i;
  bytes[palWa + i * 4 + 1] = i;
  bytes[palWa + i * 4 + 2] = i;
}

function makeSurface(slot, w, h, bitsWa) {
  const entry = DX_OBJECTS + slot * 32;
  dv.setUint32(entry, 2, true);        // DDSurface
  dv.setUint16(entry + 12, w, true);
  dv.setUint16(entry + 14, h, true);
  dv.setUint16(entry + 16, 8, true);   // bpp
  dv.setUint16(entry + 18, w, true);   // pitch
  dv.setUint32(entry + 20, bitsWa, true);
  dv.setUint32(entry + 28, 1, true);   // primary
  return entry;
}

const win = { ...WIN };
const canvas = new Canvas(64, 16);
const renderer = {
  windows: { [hwnd]: win },
  getWindowCanvas() { return { ctx: canvas.getContext('2d') }; },
  _computeClientRect(w) { w.clientRect = { ...CLIENT }; },
  scheduleRepaint() {},
};

let windowedDeviceHwnd = 0;
const { gdi } = createHostImports({
  getMemory: () => memory,
  exports: {
    get_main_hwnd: () => hwnd,
    get_dx_primary_pal_wa: () => palWa,
    get_dx_exclusive_hwnd: () => 0,
    get_d3d9_windowed_hwnd: () => windowedDeviceHwnd,
    wnd_client_screen_x: () => CLIENT.x,
    wnd_client_screen_y: () => CLIENT.y,
  },
  renderer,
});

const layerPixel = (x, y) => {
  const layer = win._dxFrameLayer;
  assert(layer, 'a presented surface must own a DX frame layer');
  return Array.from(layer.canvas.getContext('2d').getImageData(x, y, 1, 1).data);
};

// ── A DirectDraw primary: screen coordinates ────────────────────────────────
const screenBits = 0x40000;
const screenEntry = makeSurface(1, 64, 16, screenBits);
// The client area's top-left corner on screen, and a pixel in the chrome that
// the app has no business painting.
bytes[screenBits + CLIENT.y * 64 + CLIENT.x] = 0xC8;
bytes[screenBits + 0] = 0x40;

assert.strictEqual(gdi.presentBestDxOffscreen(true), 1, 'the primary must upload');
assert.strictEqual(win._dxFrameLayer.w, WIN.w,
  'the layer is composited at the window origin, so it is window-sized once clipped');
assert.strictEqual(win._dxFrameLayer.h, WIN.h, 'and window-tall');
assert.deepStrictEqual(layerPixel(DEST_X, DEST_Y), [0xC8, 0xC8, 0xC8, 255],
  'screen (14,9) is the client origin, which is window-local (4,5)');
assert.deepStrictEqual(layerPixel(0, 0), [0, 0, 0, 0],
  'the caption and border must stay transparent so the chrome shows through');

// ── A windowed Direct3D9 render target: client coordinates ──────────────────
dv.setUint32(screenEntry, 0, true);   // release the primary
windowedDeviceHwnd = deviceChild;
const clientBits = 0x50000;
makeSurface(2, CLIENT.w, CLIENT.h, clientBits);
bytes[clientBits + 0] = 0x90;                     // its own (0,0)
bytes[clientBits + CLIENT.w * CLIENT.h - 1] = 0x70; // and its bottom-right

assert.strictEqual(gdi.presentBestDxOffscreen(true), 1,
  'the windowed render target must upload');
assert.deepStrictEqual(layerPixel(DEST_X, DEST_Y), [0x90, 0x90, 0x90, 255],
  'a windowed D3D9 target starts at the client origin, not at screen (0,0)');
assert.deepStrictEqual(
  layerPixel(DEST_X + CLIENT.w - 1, DEST_Y + CLIENT.h - 1), [0x70, 0x70, 0x70, 255],
  'and its last pixel lands on the last pixel of the client area');
assert.deepStrictEqual(layerPixel(0, 0), [0, 0, 0, 0],
  'the previous frame must be cleared, not left under the chrome');

// The distinction only exists because WAT reports it. Pin both halves.
const d3d9Wat = fs.readFileSync(path.join(ROOT, 'src', '09ad-handlers-d3d9.wat'), 'utf8');
const exportsWat = fs.readFileSync(path.join(ROOT, 'src', '13-exports.wat'), 'utf8');
assert.match(d3d9Wat,
  /\$handle_IDirect3D9_CreateDevice[\s\S]*?global\.set \$d3d9_windowed_hwnd/,
  'CreateDevice must record the device window of a windowed device');
assert.match(exportsWat, /\(export "get_d3d9_windowed_hwnd"\)/,
  'the compositor needs that window exported to tell the two surface kinds apart');

console.log('PASS  DirectX frames land on the client area in window-local coordinates');
