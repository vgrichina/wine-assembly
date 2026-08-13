#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  let canvasLineFallbacks = 0;
  const harness = await bootRenderHarness({
    extraHostOverrides: {
      gdi_line_to: () => {
        canvasLineFallbacks++;
        return 1;
      },
    },
  });
  const { exports: wat, host, gdi, memory } = harness;
  const bytes = new Uint8Array(memory.buffer);

  const createBitmap = (w, h) => {
    const bitmap = wat.test_call_CreateCompatibleBitmap(0, w, h) >>> 0;
    assert(bitmap, 'CreateCompatibleBitmap should allocate a handle');
    const object = gdi._gdiObjects[bitmap];
    assert(object && object.softwareBitmap, 'compatible bitmap should use software backing');
    assert.strictEqual(object.dibSection, undefined, 'compatible bitmap must remain a DDB');
    return { bitmap, object };
  };

  const selectBitmap = bitmap => {
    const hdc = host.gdi_create_compat_dc(0);
    host.gdi_select_object(hdc, bitmap);
    return hdc;
  };

  const first = createBitmap(18, 14);
  const firstStorage = host.gdi_get_object_storage(first.bitmap) >>> 0;
  assert(firstStorage, 'DDB should expose private storage to WAT');
  assert.strictEqual(host.gdi_get_object_bits(first.bitmap), 0,
    'DDB storage must not be exposed as DIB bits');

  const bitmapStruct = wat.guest_alloc(24) >>> 0;
  assert.strictEqual(wat.test_call_GetObjectA(first.bitmap, 24, bitmapStruct), 24);
  assert.strictEqual(wat.guest_read32(bitmapStruct + 4), 18);
  assert.strictEqual(wat.guest_read32(bitmapStruct + 8), 14);
  assert.strictEqual(wat.guest_read32(bitmapStruct + 20), 0,
    'GetObject(BITMAP).bmBits must stay NULL for a DDB');
  wat.guest_free(bitmapStruct);

  const firstDc = selectBitmap(first.bitmap);
  const wideRed = host.gdi_create_pen(0, 5, 0x000000FF);
  host.gdi_select_object(firstDc, wideRed);
  assert.strictEqual(wat.test_call_MoveToEx(firstDc, 2, 2), 1);
  assert.strictEqual(wat.test_call_LineTo(firstDc, 15, 11), 1);
  assert.strictEqual(canvasLineFallbacks, 0,
    'supported wide compatible-bitmap line must not use Canvas geometry');

  const canonicalColors = new Set();
  for (let i = 0; i < 18 * 14; i++) {
    const p = firstStorage + i * 4;
    canonicalColors.add(bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16));
  }
  assert.deepStrictEqual([...canonicalColors].sort((a, b) => a - b), [0, 0xFF0000],
    'WAT wide line should contain only background and pen pixels');
  const rgba = first.object.canvas.getContext('2d').getImageData(0, 0, 18, 14).data;
  const presentedColors = new Set();
  for (let i = 0; i < rgba.length; i += 4) {
    presentedColors.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
  }
  assert.deepStrictEqual([...presentedColors].sort((a, b) => a - b), [0, 0xFF0000],
    'derived Canvas presentation should contain no antialiased fringe colors');

  host.gdi_delete_dc(firstDc);
  assert.strictEqual(wat.test_call_DeleteObject(first.bitmap), 1);
  assert.strictEqual(gdi._gdiObjects[first.bitmap], undefined,
    'DeleteObject should remove the DDB host presentation record');
  const reused = createBitmap(18, 14);
  assert.strictEqual(host.gdi_get_object_storage(reused.bitmap) >>> 0, firstStorage,
    'DeleteObject should return private DDB pages to the WAT arena');

  const mixed = createBitmap(12, 8);
  const mixedDc = selectBitmap(mixed.bitmap);
  const blueBrush = host.gdi_create_solid_brush(0x00FF0000);
  const nullPen = host.gdi_create_pen(5, 1, 0);
  host.gdi_select_object(mixedDc, blueBrush);
  host.gdi_select_object(mixedDc, nullPen);
  assert.strictEqual(host.gdi_rectangle(mixedDc, 1, 1, 11, 7), 1);
  assert.strictEqual(host.gdi_get_pixel(mixedDc, 3, 3) >>> 0, 0x00FF0000,
    'legacy Canvas write should be mirrored into canonical DDB storage');

  const greenPen = host.gdi_create_pen(0, 1, 0x0000FF00);
  host.gdi_select_object(mixedDc, greenPen);
  assert.strictEqual(wat.test_gdi_dc_set_rop2(mixedDc, 7), 13); // R2_XORPEN
  assert.strictEqual(wat.test_gdi_line_try(mixedDc, 2, 3, 9, 3), 1);
  assert.strictEqual(host.gdi_get_pixel(mixedDc, 3, 3) >>> 0, 0x00FFFF00,
    'WAT ROP2 should consume pixels written by a legacy Canvas primitive');

  const copied = createBitmap(12, 8);
  const copiedDc = selectBitmap(copied.bitmap);
  assert.strictEqual(host.gdi_bitblt(copiedDc, 0, 0, 12, 8,
    mixedDc, 0, 0, 0x00CC0020), 1);
  assert.strictEqual(host.gdi_get_pixel(copiedDc, 3, 3) >>> 0, 0x00FFFF00,
    'Canvas BitBlt should preserve a presented WAT pixel in destination backing');

  for (const hdc of [mixedDc, copiedDc]) host.gdi_delete_dc(hdc);
  for (const bitmap of [reused.bitmap, mixed.bitmap, copied.bitmap]) {
    assert.strictEqual(wat.test_call_DeleteObject(bitmap), 1);
  }
  for (const object of [wideRed, blueBrush, nullPen, greenPen]) host.gdi_delete_object(object);

  console.log('PASS  compatible DDBs use canonical WAT pixels across legacy Canvas operations');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
