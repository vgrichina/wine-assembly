#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: wat, memory, hostCtx } = await bootRenderHarness();
  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const writeRect = (pointer, left, top, right, bottom) => {
    wat.guest_write32(pointer, left);
    wat.guest_write32(pointer + 4, top);
    wat.guest_write32(pointer + 8, right);
    wat.guest_write32(pointer + 12, bottom);
  };

  // One solid 8x8 glyph. All other bytes map to A through dfDefaultChar,
  // which makes pixel placement deterministic without a platform font.
  const fnt = Buffer.alloc(142);
  fnt.writeUInt16LE(0x0200, 0);
  fnt.writeUInt32LE(fnt.length, 2);
  fnt.writeUInt16LE(8, 74);
  fnt.writeUInt16LE(400, 83);
  fnt.writeUInt16LE(8, 88);
  fnt.writeUInt16LE(8, 91);
  fnt.writeUInt16LE(8, 93);
  fnt[95] = 65;
  fnt[96] = 65;
  fnt[97] = 0;
  fnt.writeUInt32LE(134, 105);
  fnt.writeUInt16LE(8, 118);
  fnt.writeUInt16LE(126, 120);
  fnt.writeUInt16LE(0, 122);
  fnt.writeUInt16LE(134, 124);
  fnt.fill(0xff, 126, 134);
  fnt.write('Layout\0', 134, 'latin1');
  hostCtx.vfs.files.set('c:\\layout.fon', { data: new Uint8Array(fnt), attrs: 0x20 });

  const path = allocZero(16);
  bytes.set(Buffer.from('LAYOUT.FON\0', 'latin1'), wa(path));
  assert.strictEqual(wat.test_call_AddFontResourceA(path), 1);

  const width = 80;
  const height = 48;
  const bmi = allocZero(40);
  wat.guest_write32(bmi, 40);
  wat.guest_write32(bmi + 4, width);
  wat.guest_write32(bmi + 8, -height);
  wat.guest_write16(bmi + 12, 1);
  wat.guest_write16(bmi + 14, 32);
  const bitsOut = allocZero(4);
  const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert(bitmap && hdc);
  wat.test_call_SelectObject(hdc, bitmap);

  const face = allocZero(32);
  [...'Layout'].forEach((character, index) =>
    wat.guest_write16(face + index * 2, character.charCodeAt(0)));
  const font = wat.test_call_CreateFontW(-8, 400, 0, face) >>> 0;
  assert(font);
  wat.test_call_SelectObject(hdc, font);
  assert(wat.test_gdi_bitmap_font_selected(hdc));

  const dibBits = wat.guest_read32(bitsOut) >>> 0;
  const pixel = (x, y) => wat.guest_read32(dibBits + (y * width + x) * 4) & 0xffffff;
  const clear = () => assert.strictEqual(
    wat.test_call_PatBlt(hdc, 0, 0, width, height, 0x00F00021), 1);
  wat.test_gdi_dc_set_field(hdc, 28, 1, 2); // TRANSPARENT
  wat.test_gdi_dc_set_field(hdc, 20, 0x000000, 0); // black

  const textAA = allocZero(3);
  bytes.set(Buffer.from('AA\0', 'latin1'), wa(textAA));
  const advances = allocZero(8);
  wat.guest_write32(advances, 12);
  wat.guest_write32(advances + 4, 12);
  const clip = allocZero(16);
  writeRect(clip, 0, 0, 10, 9);

  clear();
  assert.strictEqual(wat.test_call_ExtTextOutAWithDx(
    hdc, 0, 0, 0x4, clip, textAA, 2, advances), 1);
  assert.strictEqual(pixel(5, 4), 0, 'first glyph must render inside ETO_CLIPPED');
  assert.strictEqual(pixel(9, 4), 0xffffff, 'clip must reject the first glyph overhang');
  assert.strictEqual(pixel(12, 4), 0xffffff, 'clip must reject the lpDx-positioned glyph');

  assert.strictEqual(wat.test_call_ExtTextOutAWithDx(
    hdc, 0, 10, 0, 0, textAA, 2, advances), 1);
  assert.strictEqual(pixel(7, 13), 0);
  assert.strictEqual(pixel(9, 13), 0xffffff, 'lpDx must leave its requested inter-glyph gap');
  assert.strictEqual(pixel(12, 13), 0, 'second glyph must begin at the lpDx advance');

  const opaque = allocZero(16);
  writeRect(opaque, 50, 2, 60, 8);
  wat.test_gdi_dc_set_field(hdc, 24, 0x000000ff, 0xffffff); // red COLORREF
  assert.strictEqual(wat.test_call_ExtTextOutAWithDx(
    hdc, 0, 0, 0x2, opaque, 0, 0, 0), 1);
  assert.strictEqual(pixel(55, 5), 0xff0000,
    'ETO_OPAQUE must erase its rectangle on the WAT bitmap path');

  const wrapped = allocZero(6);
  bytes.set(Buffer.from('AA AA\0', 'latin1'), wa(wrapped));
  const calc = allocZero(16);
  writeRect(calc, 3, 4, 27, 40);
  assert.strictEqual(wat.test_call_DrawTextA(hdc, wrapped, 5, calc, 0x10 | 0x400), 16);
  assert.strictEqual(wat.guest_read32(calc + 8), 19,
    'DT_CALCRECT must report the widest wrapped bitmap line');
  assert.strictEqual(wat.guest_read32(calc + 12), 20,
    'DT_CALCRECT must report two native 8px bitmap lines');

  clear();
  const centered = allocZero(16);
  writeRect(centered, 20, 20, 44, 30);
  assert.strictEqual(wat.test_call_DrawTextA(hdc, textAA, 2, centered, 0x1 | 0x20), 8);
  assert.strictEqual(pixel(23, 23), 0xffffff, 'DT_CENTER must preserve the left margin');
  assert.strictEqual(pixel(24, 23), 0, 'DT_CENTER must place the 16px line at x=24');
  assert.strictEqual(pixel(39, 23), 0);
  assert.strictEqual(pixel(40, 23), 0xffffff, 'DT_CENTER must preserve the right margin');

  clear();
  const bottom = allocZero(16);
  writeRect(bottom, 0, 30, 20, 46);
  assert.strictEqual(wat.test_call_DrawTextA(hdc, textAA, 2, bottom, 0x8 | 0x20), 8);
  assert.strictEqual(pixel(3, 35), 0xffffff, 'DT_BOTTOM must leave the upper margin clear');
  assert.strictEqual(pixel(3, 41), 0, 'DT_BOTTOM must anchor the bitmap baseline block');

  assert.strictEqual(wat.test_call_RemoveFontResourceA(path), 1);
  console.log('PASS  WAT bitmap ExtTextOut and DrawText honor native layout semantics');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
