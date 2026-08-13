#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: wat, memory } = await bootRenderHarness();
  const width = 96;
  const height = 32;
  const bmi = wat.guest_alloc(40) >>> 0;
  const bitsOut = wat.guest_alloc(4) >>> 0;
  wat.guest_write32(bmi, 40);
  wat.guest_write32(bmi + 4, width);
  wat.guest_write32(bmi + 8, -height);
  wat.guest_write16(bmi + 12, 1);
  wat.guest_write16(bmi + 14, 32);
  const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert(bitmap && hdc);
  assert.strictEqual(wat.test_call_SelectObject(hdc, bitmap) >>> 0, 0x30007);
  assert.strictEqual(wat.test_call_PatBlt(hdc, 0, 0, width, height, 0x00F00021), 1);

  const text = 'MMMMMMMMMMMM';
  const textGa = wat.guest_alloc(text.length + 1) >>> 0;
  const imageBase = wat.get_image_base() >>> 0;
  const textWa = 0x12000 + (textGa - imageBase);
  const bytes = new Uint8Array(memory.buffer);
  for (let i = 0; i < text.length; i++) bytes[textWa + i] = text.charCodeAt(i);
  bytes[textWa + text.length] = 0;
  const clipRect = wat.guest_alloc(16) >>> 0;
  const opaqueRect = wat.guest_alloc(16) >>> 0;
  const writeRect = (p, l, t, r, b) => {
    wat.guest_write32(p, l); wat.guest_write32(p + 4, t);
    wat.guest_write32(p + 8, r); wat.guest_write32(p + 12, b);
  };
  writeRect(clipRect, 0, 0, 18, 24);
  writeRect(opaqueRect, 30, 2, 42, 12);

  wat.test_gdi_dc_set_field(hdc, 28, 1, 2); // TRANSPARENT
  wat.test_gdi_dc_set_field(hdc, 20, 0x000000, 0); // black
  assert.strictEqual(
    wat.test_call_ExtTextOutA(hdc, 0, 5, 0x4, clipRect, textGa, text.length), 1);
  wat.test_gdi_dc_set_field(hdc, 24, 0x000000FF, 0xFFFFFF); // red COLORREF
  assert.strictEqual(
    wat.test_call_ExtTextOutA(hdc, 0, 0, 0x2, opaqueRect, 0, 0), 1);

  const bitsGa = wat.guest_read32(bitsOut) >>> 0;
  const bitsWa = 0x1C000000 + (bitsGa - 0x50000000);
  const rgb = (x, y) => {
    const p = bitsWa + (y * width + x) * 4;
    return [bytes[p + 2], bytes[p + 1], bytes[p]];
  };
  let insideClipDark = 0;
  let outsideClipDark = 0;
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 18; x++) {
      if (rgb(x, y).every(c => c < 100)) insideClipDark++;
    }
    for (let x = 40; x < 70; x++) {
      if (rgb(x, y).every(c => c < 100)) outsideClipDark++;
    }
  }
  assert(insideClipDark > 0, 'ETO_CLIPPED must draw glyph pixels inside its rect');
  assert.strictEqual(outsideClipDark, 0, 'ETO_CLIPPED must reject glyph pixels outside its rect');
  assert.deepStrictEqual(rgb(35, 6), [255, 0, 0],
    'ETO_OPAQUE must fill its rect when text is null');

  console.log('PASS  canonical ExtTextOut clips glyphs and supports null-text opaque erases');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
