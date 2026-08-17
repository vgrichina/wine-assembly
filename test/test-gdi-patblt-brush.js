#!/usr/bin/env node

// PatBlt(PATCOPY) fills with the DC's currently selected brush. FreeCell 16-bit
// builds its empty-cell image exactly that way -- compatible DC, compatible
// bitmap, solid brush, one PATCOPY over the whole bitmap -- and then blits the
// result into each cell. When the fill loses the brush the cells come out
// black, which is indistinguishable from "nothing was drawn" on screen.

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const harness = await bootRenderHarness();
  const { exports: wat, memory } = harness;
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const descriptor = 0x07EF1000;
  const PATCOPY = 0x00F00021;
  const W = 71, H = 96;                 // FreeCell's card metrics
  const GREEN = 0x00007F00;             // its table colour, COLORREF 0x00BBGGRR

  const bitmap = wat.test_call_CreateCompatibleBitmap(0, W, H) >>> 0;
  assert(bitmap, 'CreateCompatibleBitmap should allocate a handle');
  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert(hdc, 'CreateCompatibleDC should allocate a handle');
  wat.test_call_SelectObject(hdc, bitmap);

  const brush = wat.test_call_CreateSolidBrush(GREEN) >>> 0;
  assert(brush, 'CreateSolidBrush should allocate a handle');
  const previous = wat.test_call_SelectObject(hdc, brush) >>> 0;
  assert(previous, 'selecting a brush should return the one it replaced');

  assert.strictEqual(wat.test_call_PatBlt(hdc, 0, 0, W, H, PATCOPY), 1,
    'PatBlt over a memory DC should report success');

  assert.strictEqual(wat.test_gdi_surface_descriptor(hdc, descriptor), 1);
  const storage = dv.getUint32(descriptor, true);
  assert(storage, 'the selected bitmap should expose private storage');
  const colors = new Set();
  for (let i = 0; i < W * H; i++) {
    const p = storage + i * 4;
    colors.add(bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16));
  }
  // Stored BGR, so the COLORREF's own byte order.
  assert.deepStrictEqual([...colors], [GREEN],
    `PATCOPY should leave only the brush colour; got ${[...colors].map(c => '0x' + c.toString(16))}`);
  console.log(`PASS  PATCOPY into a memory DC fills with the selected brush (${W}x${H})`);

  // The same fill through GetPixel, which is the path an app uses to sample
  // what it just drew -- Solitaire reads back four corners per card.
  const pixel = wat.test_call_GetPixel(hdc, W >> 1, H >> 1) >>> 0;
  assert.strictEqual(pixel, GREEN,
    `GetPixel after PATCOPY should read the brush colour, got 0x${pixel.toString(16)}`);
  console.log('PASS  GetPixel reads the filled colour back');

  console.log('\n2 passed, 0 failed');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
