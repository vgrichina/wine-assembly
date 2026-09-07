#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const RegionMap = require('../lib/region-map.generated.js');

const colorApiWat = String.raw`
  (func (export "test_set_text_color") (param i32 i32) (result i32)
    (call $host_gdi_set_text_color (local.get 0) (local.get 1)))
  (func (export "test_get_text_color") (param i32) (result i32)
    (call $host_gdi_get_text_color (local.get 0)))
  (func (export "test_set_bk_color") (param i32 i32) (result i32)
    (call $host_gdi_set_bk_color (local.get 0) (local.get 1)))
  (func (export "test_get_bk_color") (param i32) (result i32)
    (call $host_gdi_get_bk_color (local.get 0)))
`;

(async () => {
  const { exports: wat, memory } = await bootRenderHarness({ extraWat: colorApiWat });
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const slot = 27;
  const hdc = 0x200000 + slot;
  const entry = RegionMap.BASE.DX_OBJECTS + slot * 32;
  const width = 32;
  const height = 24;
  const stride = width;
  const bitsGa = wat.guest_alloc(stride * height) >>> 0;
  const bitsWa = RegionMap.g2w(bitsGa, wat.get_image_base());
  const paletteGa = wat.guest_alloc(1024) >>> 0;
  const paletteWa = RegionMap.g2w(paletteGa, wat.get_image_base());

  bytes.fill(0, paletteWa, paletteWa + 1024);
  bytes.set([0, 0, 0, 0], paletteWa); // index 0: black
  bytes.set([255, 255, 255, 0], paletteWa + 4); // index 1: white
  // Deliberately duplicate black: an RGB round trip would choose index 0,
  // while DIBINDEX must preserve the caller's device-pixel index 7.
  bytes.set([0, 0, 0, 0], paletteWa + 7 * 4);
  bytes.fill(1, bitsWa, bitsWa + stride * height);
  wat.test_dx_set_primary_palette_wa(paletteWa);

  dv.setUint32(entry, 2, true); // DDSurface
  dv.setUint16(entry + 12, width, true);
  dv.setUint16(entry + 14, height, true);
  dv.setUint16(entry + 16, 8, true);
  dv.setUint16(entry + 18, stride, true);
  dv.setUint32(entry + 20, bitsWa, true);
  assert.strictEqual(wat.test_gdi_dx_dc_bind(hdc), 1);

  const dibIndex7 = 0x10FF0007;
  const dibIndex1 = 0x10FF0001;
  assert.strictEqual(wat.test_set_text_color(hdc, dibIndex7) >>> 0, 0);
  assert.strictEqual(wat.test_get_text_color(hdc) >>> 0, dibIndex7);
  assert.strictEqual(wat.test_set_bk_color(hdc, dibIndex1) >>> 0, 0x00FFFFFF);
  assert.strictEqual(wat.test_get_bk_color(hdc) >>> 0, dibIndex1);
  wat.test_gdi_dc_set_field(hdc, 28, 1, 2); // TRANSPARENT

  const text = wat.guest_alloc(2) >>> 0;
  wat.guest_write16(text, 0x58); // X\0
  assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 2, text, 1), 1);
  assert(bytes.subarray(bitsWa, bitsWa + stride * height).includes(7),
    'DIBINDEX text must write the requested destination palette color');
  assert(!bytes.subarray(bitsWa, bitsWa + stride * height).includes(2),
    'the qualified COLORREF must not be truncated into a literal RGB color');

  wat.test_gdi_dx_dc_release(hdc);
  console.log('DIBINDEX text colors: PASS');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
