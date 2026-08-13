#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const harness = await bootRenderHarness();
  const { exports: wat, host, gdi, memory } = harness;
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const descriptor = 0x07EF1000;

  const createBitmap = (w, h) => {
    const bitmap = wat.test_call_CreateCompatibleBitmap(0, w, h) >>> 0;
    assert(bitmap, 'CreateCompatibleBitmap should allocate a handle');
    const presentation = gdi.surfacePresentations.get(bitmap);
    assert(presentation, 'compatible bitmap should have a derived presentation surface');
    return { bitmap, presentation };
  };

  const selectBitmap = bitmap => {
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert.strictEqual(wat.test_call_SelectObject(hdc, bitmap), 0x30007);
    return hdc;
  };

  const first = createBitmap(18, 14);
  const bitmapStruct = wat.guest_alloc(24) >>> 0;
  assert.strictEqual(wat.test_call_GetObjectA(first.bitmap, 24, bitmapStruct), 24);
  assert.strictEqual(wat.guest_read32(bitmapStruct + 4), 18);
  assert.strictEqual(wat.guest_read32(bitmapStruct + 8), 14);
  assert.strictEqual(wat.guest_read32(bitmapStruct + 20), 0,
    'GetObject(BITMAP).bmBits must stay NULL for a DDB');
  wat.guest_free(bitmapStruct);

  const firstDc = selectBitmap(first.bitmap);
  assert.strictEqual(wat.test_gdi_surface_descriptor(firstDc, descriptor), 1);
  const firstStorage = dv.getUint32(descriptor, true);
  assert(firstStorage, 'DDB should expose private storage only to WAT');
  const wideRed = wat.test_call_CreatePen(0, 5, 0x000000FF) >>> 0;
  wat.test_call_SelectObject(firstDc, wideRed);
  assert.strictEqual(wat.test_gdi_line_try(firstDc, 2, 2, 15, 11), 1);

  const canonicalColors = new Set();
  for (let i = 0; i < 18 * 14; i++) {
    const p = firstStorage + i * 4;
    canonicalColors.add(bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16));
  }
  assert.deepStrictEqual([...canonicalColors].sort((a, b) => a - b), [0, 0xFF0000],
    'WAT wide line should contain only background and pen pixels');
  const rgba = first.presentation.canvas.getContext('2d').getImageData(0, 0, 18, 14).data;
  const presentedColors = new Set();
  for (let i = 0; i < rgba.length; i += 4) {
    presentedColors.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
  }
  assert.deepStrictEqual([...presentedColors].sort((a, b) => a - b), [0, 0xFF0000],
    'derived Canvas presentation should contain no antialiased fringe colors');

  assert.strictEqual(wat.test_call_DeleteDC(firstDc), 1);
  assert.strictEqual(wat.test_call_DeleteObject(first.bitmap), 1);
  assert.strictEqual(gdi.surfacePresentations.has(first.bitmap), false,
    'DeleteObject should remove the derived presentation surface');
  const reused = createBitmap(18, 14);
  const reusedDc = selectBitmap(reused.bitmap);
  assert.strictEqual(wat.test_gdi_surface_descriptor(reusedDc, descriptor), 1);
  assert.strictEqual(dv.getUint32(descriptor, true), firstStorage,
    'DeleteObject should return private DDB pages to the WAT arena');
  assert.strictEqual(wat.test_call_DeleteDC(reusedDc), 1);
  assert.strictEqual(wat.test_call_DeleteObject(reused.bitmap), 1);
  assert.strictEqual(wat.test_call_DeleteObject(wideRed), 1);

  console.log('PASS  compatible DDBs use canonical WAT pixels and derived presentation');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
