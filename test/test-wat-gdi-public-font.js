#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const canvasCalls = {
    bind: 0, textOut: 0, extTextOut: 0, drawText: 0, measure: 0, metrics: 0,
  };
  const { exports: wat, memory, hostCtx } = await bootRenderHarness({
    extraHostOverrides: {
      gdi_text_bind: () => { canvasCalls.bind++; return 1; },
      gdi_text_out: () => { canvasCalls.textOut++; return 1; },
      gdi_ext_text_out: () => { canvasCalls.extTextOut++; return 1; },
      gdi_draw_text: () => { canvasCalls.drawText++; return 8; },
      measure_text: (_hdc, _text, count) => { canvasCalls.measure++; return count * 8; },
      get_text_metrics: () => { canvasCalls.metrics++; return 8 | (8 << 16); },
    },
  });
  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  let passed = 0;

  const check = (name, fn) => {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  };
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const createTextDc = () => {
    const bmi = allocZero(40);
    wat.guest_write32(bmi, 40);
    wat.guest_write32(bmi + 4, 64);
    wat.guest_write32(bmi + 8, -32);
    wat.guest_write16(bmi + 12, 1);
    wat.guest_write16(bmi + 14, 32);
    const bitsOut = allocZero(4);
    const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert(bitmap && hdc);
    wat.test_call_SelectObject(hdc, bitmap);
    return { bitmap, hdc, bits: wat.guest_read32(bitsOut) >>> 0 };
  };

  check('ANSI extent-ex returns progressive widths and exact fit count', () => {
    const { hdc } = createTextDc();
    const text = allocZero(4);
    bytes.set(Buffer.from('Wi!\0', 'latin1'), wa(text));
    const fit = allocZero(4);
    const dx = allocZero(12);
    const size = allocZero(8);
    assert.strictEqual(wat.test_call_GetTextExtentExPointA(
      hdc, text, 3, 0x7fffffff, fit, dx, size), 1);
    const widths = [0, 1, 2].map(index => wat.guest_read32(dx + index * 4));
    assert(widths[0] > 0 && widths[1] >= widths[0] && widths[2] >= widths[1]);
    assert.strictEqual(wat.guest_read32(fit), 3);
    assert.strictEqual(wat.guest_read32(size), widths[2]);
    assert(wat.guest_read32(size + 4) > 0);
    assert.strictEqual(wat.test_call_GetTextExtentExPointA(
      hdc, text, 3, widths[0], fit, 0, size), 1);
    assert.strictEqual(wat.guest_read32(fit), 1);
  });

  check('UTF-16 extent-ex shares Canvas measurement and WAT prefix fitting', () => {
    const { hdc } = createTextDc();
    const text = allocZero(8);
    ['W', 'i', '!'].forEach((character, index) =>
      wat.guest_write16(text + index * 2, character.charCodeAt(0)));
    const fit = allocZero(4);
    const dx = allocZero(12);
    const size = allocZero(8);
    assert.strictEqual(wat.test_call_GetTextExtentExPointW(
      hdc, text, 3, 0x7fffffff, fit, dx, size), 1);
    assert.strictEqual(wat.guest_read32(fit), 3);
    assert.strictEqual(wat.guest_read32(size), wat.guest_read32(dx + 8));
    assert(wat.guest_read32(dx) > 0);
  });

  check('ABC widths expose measured B advances with zero side bearings', () => {
    const { hdc } = createTextDc();
    const abc = allocZero(36);
    assert.strictEqual(wat.test_call_GetCharABCWidthsA(hdc, 65, 67, abc), 1);
    for (let index = 0; index < 3; index++) {
      assert.strictEqual(wat.guest_read32(abc + index * 12), 0);
      assert(wat.guest_read32(abc + index * 12 + 4) > 0);
      assert.strictEqual(wat.guest_read32(abc + index * 12 + 8), 0);
    }
  });

  check('GetGlyphOutlineA provides GGO_METRICS and rejects unavailable bitmaps', () => {
    const { hdc } = createTextDc();
    const metrics = allocZero(20);
    assert.strictEqual(wat.test_call_GetGlyphOutlineA(hdc, 65, 0, metrics, 0, 0, 0), 0);
    assert(wat.guest_read32(metrics) > 0);
    assert(wat.guest_read32(metrics + 4) > 0);
    assert.strictEqual(wat.test_call_GetGlyphOutlineA(hdc, 65, 1, metrics, 0, 0, 0) >>> 0,
      0xffffffff);
  });

  check('font-resource and unavailable font-table contracts are deterministic', () => {
    // Minimal standalone FNT 2.0 strike: one 8x8 glyph plus a face name.
    // This keeps the unit test independent of the optional Win98 fixtures.
    const fnt = Buffer.alloc(142);
    fnt.writeUInt16LE(0x0200, 0);
    fnt.writeUInt32LE(fnt.length, 2);
    fnt.writeUInt16LE(8, 74);  // ascent
    fnt.writeUInt16LE(400, 83); // weight
    fnt.writeUInt16LE(8, 88);  // pixel height
    fnt.writeUInt16LE(8, 91);  // average width
    fnt.writeUInt16LE(8, 93);  // maximum width
    fnt[95] = 65;              // first char
    fnt[96] = 65;              // last char
    fnt[97] = 0;               // default-char offset
    fnt.writeUInt32LE(134, 105); // face-name offset
    fnt.writeUInt16LE(8, 118);
    fnt.writeUInt16LE(126, 120);
    fnt.writeUInt16LE(0, 122); // sentinel entry
    fnt.writeUInt16LE(134, 124);
    fnt.fill(0x3c, 126, 134); // Four centered pixels on every row.
    fnt.write('UnitFnt\0', 134, 'latin1');
    hostCtx.vfs.files.set('c:\\test.fon', { data: new Uint8Array(fnt), attrs: 0x20 });

    const { hdc, bits: dibBits } = createTextDc();
    const path = allocZero(16);
    bytes.set(Buffer.from('TEST.FON\0', 'latin1'), wa(path));
    assert.strictEqual(wat.test_call_AddFontResourceA(path), 1);
    assert.strictEqual(wat.test_gdi_bitmap_font_count(), 1);

    const face = allocZero(32);
    [...'UnitFnt'].forEach((character, index) =>
      wat.guest_write16(face + index * 2, character.charCodeAt(0)));
    const font = wat.test_call_CreateFontW(-8, 400, 0, face) >>> 0;
    assert(font);
    assert(wat.test_gdi_bitmap_font_bound(font));
    wat.test_call_SelectObject(hdc, font);
    assert.strictEqual(wat.test_gdi_bitmap_font_selected(hdc),
      wat.test_gdi_bitmap_font_bound(font));
    Object.keys(canvasCalls).forEach(key => { canvasCalls[key] = 0; });
    const text = allocZero(2);
    bytes[wa(text)] = 65;
    const size = allocZero(8);
    assert.strictEqual(wat.test_call_GetTextExtentExPointA(
      hdc, text, 1, 0x7fffffff, 0, 0, size), 1);
    assert.strictEqual(wat.guest_read32(size), 8);
    assert.strictEqual(wat.guest_read32(size + 4), 8);

    const metrics = allocZero(20);
    assert.strictEqual(wat.test_call_GetGlyphOutlineA(
      hdc, 65, 0, metrics, 0, 0, 0), 0);
    assert.deepStrictEqual([
      wat.guest_read32(metrics),
      wat.guest_read32(metrics + 4),
      wat.guest_read32(metrics + 8),
      wat.guest_read32(metrics + 12),
      wat.guest_read32(metrics + 16) & 0xffff,
      wat.guest_read32(metrics + 16) >>> 16,
    ], [4, 8, 2, 8, 8, 0]);
    assert.strictEqual(wat.test_call_GetGlyphOutlineA(
      hdc, 65, 1, metrics, 0, 0, 0), 32);
    const glyphBitmap = allocZero(36);
    bytes.fill(0xa5, wa(glyphBitmap), wa(glyphBitmap) + 36);
    assert.strictEqual(wat.test_call_GetGlyphOutlineA(
      hdc, 65, 1, metrics, 31, glyphBitmap, 0) >>> 0, 0xffffffff);
    assert.deepStrictEqual([...bytes.slice(wa(glyphBitmap), wa(glyphBitmap) + 36)],
      Array(36).fill(0xa5));
    assert.strictEqual(wat.test_call_GetGlyphOutlineA(
      hdc, 65, 1, metrics, 32, glyphBitmap, 0), 32);
    assert.deepStrictEqual([...bytes.slice(wa(glyphBitmap), wa(glyphBitmap) + 32)],
      Array.from({ length: 8 }, () => [0xf0, 0, 0, 0]).flat());
    assert.deepStrictEqual([...bytes.slice(wa(glyphBitmap) + 32, wa(glyphBitmap) + 36)],
      Array(4).fill(0xa5));
    const identity = allocZero(16);
    wat.guest_write32(identity, 0x00010000);
    wat.guest_write32(identity + 12, 0x00010000);
    assert.strictEqual(wat.test_call_GetGlyphOutlineA(
      hdc, 65, 0x101, metrics, 32, glyphBitmap, identity), 32);
    wat.guest_write32(identity + 4, 0x00008000);
    assert.strictEqual(wat.test_call_GetGlyphOutlineA(
      hdc, 65, 1, metrics, 32, glyphBitmap, identity) >>> 0, 0xffffffff);

    // Seed the canonical top-down DIB with a non-GDI byte pattern. The FNT
    // glyph must write its opaque white cell and centered black foreground.
    for (let offset = 0; offset < 64 * 32 * 4; offset += 4) {
      wat.guest_write32(dibBits + offset, 0x7f7f7f7f);
    }
    assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 3, text, 1), 1);
    assert.strictEqual(wat.guest_read32(dibBits + (3 * 64 + 2) * 4), 0x00ffffff);
    assert.strictEqual(wat.guest_read32(dibBits + (3 * 64 + 4) * 4), 0);
    assert.deepStrictEqual(canvasCalls, {
      bind: 0, textOut: 0, extTextOut: 0, drawText: 0, measure: 0, metrics: 0,
    }, 'selected user FNT metrics, glyph extraction, and rasterization must stay in WAT');
    assert.strictEqual(wat.test_call_RemoveFontResourceA(path), 1);
    assert.strictEqual(wat.test_gdi_bitmap_font_count(), 0);
    assert.strictEqual(wat.test_call_AddFontResourceA(0), 0);
    assert.strictEqual(wat.test_call_GetFontData(hdc, 0, 0, 0, 0) >>> 0, 0xffffffff);
  });

  console.log(`\n${passed}/${passed} checks passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
