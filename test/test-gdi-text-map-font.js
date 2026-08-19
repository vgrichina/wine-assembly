#!/usr/bin/env node

'use strict';

// WordPad Print Preview establishes MM_ANISOTROPIC and then scales the logical
// window by screen/printer DPI (96/300). A 13px logical font has to come out as
// a ~3px device glyph; when it did not, preview lines overlapped.
//
// This used to check the JS font resolver, which applied the mapping while
// building a CSS font string. There is no JS font resolver any more — the
// mapping is applied in $gdi_bitmap_font_height when a strike is chosen — so
// the same guarantee is now asserted through the public metrics API.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: wat, memory } = await bootRenderHarness();
  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const writeWide = value => {
    const pointer = allocZero((value.length + 1) * 2);
    [...value].forEach((character, index) =>
      wat.guest_write16(pointer + index * 2, character.charCodeAt(0)));
    return pointer;
  };

  const bmi = allocZero(40);
  wat.guest_write32(bmi, 40);
  wat.guest_write32(bmi + 4, 256);
  wat.guest_write32(bmi + 8, -128);
  wat.guest_write16(bmi + 12, 1);
  wat.guest_write16(bmi + 14, 32);
  const bitsOut = allocZero(4);
  const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert(bitmap && hdc);
  wat.test_call_SelectObject(hdc, bitmap);

  const font = wat.test_call_CreateFontW(-13, 400, 0, writeWide('Times New Roman')) >>> 0;
  assert(font, 'CreateFontW should return a font handle');
  wat.test_call_SelectObject(hdc, font);

  const tm = allocZero(64);
  const heightOf = () => {
    assert.strictEqual(wat.test_call_GetTextMetricsA(hdc, tm), 1);
    return wat.guest_read32(tm) | 0;
  };

  // 1:1 mapping first: the unscaled cell for a 13px request.
  const unscaled = heightOf();
  assert(unscaled >= 8, `unscaled cell should be a usable size, got ${unscaled}`);

  // MM_ANISOTROPIC with WordPad's 96/300 DPI window, applied to the Y extents
  // that $gdi_bitmap_font_height reads (DC offsets 52 and 68).
  assert.strictEqual(wat.test_call_SetMapMode(hdc, 8), 1);
  wat.test_gdi_dc_set_field(hdc, 52, 5242, 1);   // 16384 * 96 / 300
  wat.test_gdi_dc_set_field(hdc, 68, 1058, 1);
  const scaled = heightOf();
  assert(scaled > 0 && scaled < unscaled,
    `anisotropic mapping must shrink the device glyph: ${unscaled} -> ${scaled}`);
  assert(scaled <= 4,
    `a 13px logical font at 1058/5242 should land near 3px, got ${scaled}`);

  console.log('PASS  anisotropic text mapping scales logical fonts into device pixels');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
