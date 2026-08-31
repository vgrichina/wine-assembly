#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { Canvas } = require('../lib/canvas-compat');
const { createHostImports } = require('../lib/host-imports');
// $DX_OBJECTS, from the map declared in src/00-regions.wat.
const RegionMap = require('../lib/region-map.generated.js');

const memory = new ArrayBuffer(128 * 1024 * 1024);
const bytes = new Uint8Array(memory);
const dv = new DataView(memory);
const slot = 3;
const entry = RegionMap.BASE.DX_OBJECTS + slot * 32;
const bits = 0x20000;
const hwnd = 0x77;
const canvas = new Canvas(4, 4);
let repaintRequests = 0;

dv.setUint32(entry, 2, true);       // DDSurface
dv.setUint16(entry + 12, 4, true);  // width
dv.setUint16(entry + 14, 4, true);  // height
dv.setUint16(entry + 16, 32, true); // bpp
dv.setUint16(entry + 18, 16, true); // pitch
dv.setUint32(entry + 20, bits, true);
dv.setUint32(entry + 28, 1, true);  // primary
bytes[bits] = 1;

const renderer = {
  windows: { [hwnd]: {} },
  getWindowCanvas() { return { ctx: canvas.getContext('2d') }; },
  scheduleRepaint() { repaintRequests++; },
};
const { host, gdi } = createHostImports({
  getMemory: () => memory,
  exports: {
    get_main_hwnd: () => hwnd,
    get_dx_primary_pal_wa: () => 0,
  },
  renderer,
});

// The periodic fallback first records the primary pixels already on screen.
assert.strictEqual(gdi.presentBestDxOffscreen(), 1);
repaintRequests = 0;

// An ordinary Unlock/Blt/Flip presentation establishes which primary surface
// owns the screen. It must not disable later signature checks of that VRAM.
host.dx_trace(5, slot, 32, bits, 0);
assert.strictEqual(gdi.presentBestDxOffscreen(), 0,
  'an unchanged explicitly presented primary must not upload twice');

// Old DirectDraw programs retain the Lock pointer and write the visible VRAM
// directly. No later DirectDraw call is required for those writes to appear.
bytes.set([0x33, 0x22, 0x11, 0], bits);
assert.strictEqual(gdi.presentBestDxOffscreen(), 1,
  'a retained primary pointer write must cross the next presentation boundary');
const presentedCanvas = renderer.windows[hwnd]._dxFrameLayer.canvas;
assert.deepStrictEqual(
  Array.from(presentedCanvas.getContext('2d').getImageData(0, 0, 1, 1).data),
  [0x11, 0x22, 0x33, 0xFF]);
assert.strictEqual(repaintRequests, 1);
assert.strictEqual(gdi.presentBestDxOffscreen(), 0,
  'the signature must suppress unchanged follow-up uploads');

console.log('DirectDraw retained primary VRAM presentation: PASS');
