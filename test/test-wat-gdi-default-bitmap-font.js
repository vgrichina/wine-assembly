#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  // Only the bundled strikes: this file's subject is what happens when a
  // scalable face has no file to rasterize from, so no TTF may be mounted.
  const harness = await bootRenderHarness({ fonts: 'bitmap' });
  const { exports: wat, memory, hostCtx } = harness;

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
  wat.guest_write32(bmi + 4, 128);
  wat.guest_write32(bmi + 8, -48);
  wat.guest_write16(bmi + 12, 1);
  wat.guest_write16(bmi + 14, 32);
  const bitsOut = allocZero(4);
  const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert(bitmap && hdc);
  wat.test_call_SelectObject(hdc, bitmap);

  const text = allocZero(16);
  bytes.set(Buffer.from('Default UI\0', 'latin1'), wa(text));
  const size = allocZero(8);
  const rect = allocZero(16);
  wat.guest_write32(rect + 8, 120);
  wat.guest_write32(rect + 12, 40);

  assert.strictEqual(wat.test_gdi_bitmap_font_count(), 0);
  assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 2, text, 10), 1);
  assert.strictEqual(wat.test_gdi_bitmap_font_count(), 2,
    'first stock-font draw should lazily install Wine System strikes');
  assert(wat.test_gdi_bitmap_font_selected(hdc), 'SYSTEM_FONT should select Wine System');
  assert.strictEqual(wat.test_call_GetTextExtentExPointA(
    hdc, text, 10, 0x7fffffff, 0, 0, size), 1);
  assert(wat.guest_read32(size) > 0 && wat.guest_read32(size + 4) === 16);
  assert.strictEqual(wat.test_call_ExtTextOutA(hdc, 2, 16, 0, 0, text, 10), 1);
  assert.strictEqual(wat.test_call_DrawTextA(hdc, text, 10, rect, 0x20), 16);

  assert.strictEqual(wat.test_call_SelectObject(hdc, 0x30021) >>> 0, 0x3001d);
  assert(wat.test_gdi_bitmap_font_selected(hdc), 'DEFAULT_GUI_FONT should select Wine MS Sans Serif');
  assert.strictEqual(wat.test_call_GetTextExtentExPointA(
    hdc, text, 10, 0x7fffffff, 0, 0, size), 1);
  assert.strictEqual(wat.guest_read32(size + 4), 13, 'Win98 dialog font cell height');
  assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 30, text, 10), 1);

  const uiFont = wat.test_call_CreateFontW(-12, 400, 0, writeWide('MS Sans Serif')) >>> 0;
  assert(uiFont && wat.test_gdi_bitmap_font_bound(uiFont),
    'MS Sans Serif should bind to its bundled Wine bitmap strike');
  assert.strictEqual(wat.test_call_SelectObject(hdc, uiFont) >>> 0, 0x30021);
  assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 88, 0) >>> 0, uiFont);
  const uiRecord = wat.test_gdi_object_record(uiFont) >>> 0;
  assert.strictEqual(new DataView(memory.buffer).getUint32(uiRecord + 4, true), 4);
  assert.strictEqual(new DataView(memory.buffer).getUint32(
    wat.test_gdi_bitmap_font_bound(uiFont), true), 1);
  assert.strictEqual(wat.test_gdi_bitmap_font_selected(hdc),
    wat.test_gdi_bitmap_font_bound(uiFont));
  assert.strictEqual(wat.test_call_TextOutA(hdc, 50, 30, text, 10), 1);

  // Preserve only Wine's three native cells. Negative LOGFONT heights
  // describe the character body, so selection must subtract dfInternalLeading
  // before comparing a request with a bitmap rung.
  const tm = allocZero(64);
  const ladder = [
    { request: -11, cell: 13, leading: 2 },
    { request: -13, cell: 16, leading: 3 },
    { request: -16, cell: 20, leading: 4 },
  ];
  for (const expected of ladder) {
    const font = wat.test_call_CreateFontW(
      expected.request, 400, 0, writeWide('MS Sans Serif')) >>> 0;
    const strike = wat.test_gdi_bitmap_font_bound(font) >>> 0;
    assert(font && strike, `MS Sans Serif ${expected.request}px must bind`);
    assert.strictEqual(new DataView(memory.buffer).getUint32(strike + 20, true),
      expected.cell, `MS Sans Serif ${expected.request}px cell`);
    assert.strictEqual(new DataView(memory.buffer).getUint32(strike + 60, true) & 0xffff,
      expected.leading, `MS Sans Serif ${expected.request}px internal leading`);
    wat.test_call_SelectObject(hdc, font);
    assert.strictEqual(wat.test_call_GetTextMetricsA(hdc, tm), 1);
    assert.strictEqual(wat.guest_read32(tm), expected.cell,
      `MS Sans Serif ${expected.request}px public tmHeight`);
  }

  // Win98's raster mapper considers integer enlargements of every stored
  // strike. With Wine's three native rungs, these are the deterministic
  // transition ranges. `source` is the stored bitmap cell; `cell` is the
  // realized cell after GDI's integral magnification.
  const mappedRanges = [
    { first: 1, last: 12, source: 13, cell: 13 },
    { first: 13, last: 15, source: 16, cell: 16 },
    { first: 16, last: 21, source: 20, cell: 20 },
    { first: 22, last: 25, source: 13, cell: 26 },
    { first: 26, last: 31, source: 16, cell: 32 },
    { first: 32, last: 32, source: 20, cell: 40 },
    { first: 33, last: 38, source: 13, cell: 39 },
    { first: 39, last: 43, source: 16, cell: 48 },
    { first: 44, last: 47, source: 13, cell: 52 },
    { first: 48, last: 48, source: 20, cell: 60 },
  ];
  for (const range of mappedRanges) {
    for (let request = range.first; request <= range.last; request++) {
      const font = wat.test_call_CreateFontW(
        -request, 400, 0, writeWide('MS Sans Serif')) >>> 0;
      const strike = wat.test_gdi_bitmap_font_bound(font) >>> 0;
      assert(font && strike, `MS Sans Serif -${request}px must bind`);
      assert.strictEqual(new DataView(memory.buffer).getUint32(strike + 20, true),
        range.source, `MS Sans Serif -${request}px source cell`);
      wat.test_call_SelectObject(hdc, font);
      assert.strictEqual(wat.test_call_GetTextMetricsA(hdc, tm), 1);
      assert.strictEqual(wat.guest_read32(tm), range.cell,
        `MS Sans Serif -${request}px realized cell`);
      const view = new DataView(memory.buffer);
      const scale = range.cell / range.source;
      const nativeAscent = view.getUint32(strike + 24, true);
      const nativeLeading = view.getUint32(strike + 60, true) & 0xffff;
      assert.strictEqual(wat.guest_read32(tm + 4), nativeAscent * scale,
        `MS Sans Serif -${request}px scaled ascent`);
      assert.strictEqual(wat.guest_read32(tm + 8),
        (range.source - nativeAscent) * scale,
        `MS Sans Serif -${request}px scaled descent`);
      assert.strictEqual(wat.guest_read32(tm + 12), nativeLeading * scale,
        `MS Sans Serif -${request}px scaled internal leading`);
    }
  }

  // No font files are mounted in this harness, so Arial cannot be rasterized
  // from its substitute here. It still must not reach Canvas: the bundled
  // MS Sans Serif strike is the last resort, which is what makes it safe for
  // there to be no host-font path at all. A browser whose font fetch failed
  // gets Win98 bitmap text rather than whatever font the machine happens to
  // have, and text never simply vanishes.
  const scalableFont = wat.test_call_CreateFontW(-12, 400, 0, writeWide('Arial')) >>> 0;
  assert(scalableFont && !wat.test_gdi_bitmap_font_bound(scalableFont),
    'explicit scalable document faces should not be silently replaced');
  wat.test_call_SelectObject(hdc, scalableFont);
  assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 2, text, 10), 1);
  assert(wat.test_gdi_bitmap_font_selected(hdc) >>> 0,
    'with no font file to rasterize, a scalable face falls back to a strike');

  assert.strictEqual(wat.test_gdi_bitmap_font_count(), 8,
    'four Wine resources plus Terminal should install eight native bitmap strikes');

  console.log('PASS  System and native-rung MS Sans Serif use Wine bitmaps without Canvas');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
