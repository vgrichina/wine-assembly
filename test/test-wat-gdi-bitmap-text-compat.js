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
  const writeAnsi = (value, extra = 1) => {
    const pointer = allocZero(value.length + extra);
    bytes.set(Buffer.from(value, 'latin1'), wa(pointer));
    return pointer;
  };
  const writeRect = (pointer, left, top, right, bottom) => {
    wat.guest_write32(pointer, left);
    wat.guest_write32(pointer + 4, top);
    wat.guest_write32(pointer + 8, right);
    wat.guest_write32(pointer + 12, bottom);
  };

  // One solid 8x8 glyph, used as every character's default glyph. Uniform
  // metrics make prefix removal, tab expansion, ellipsis, and advances exact.
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
  fnt.write('Compat\0', 134, 'latin1');
  hostCtx.vfs.files.set('c:\\compat.fon', { data: new Uint8Array(fnt), attrs: 0x20 });

  const path = writeAnsi('COMPAT.FON');
  assert.strictEqual(wat.test_call_AddFontResourceA(path), 1);

  const width = 96;
  const height = 64;
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
  [...'Compat'].forEach((character, index) =>
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

  const calc = allocZero(16);
  const prefixed = writeAnsi('A&A');
  writeRect(calc, 0, 0, 80, 20);
  assert.strictEqual(wat.test_call_DrawTextA(hdc, prefixed, 3, calc, 0x400), 8);
  assert.strictEqual(wat.guest_read32(calc + 8), 16,
    'DrawText must hide a mnemonic prefix from measurement');

  const escaped = writeAnsi('A&&A');
  writeRect(calc, 0, 0, 80, 20);
  assert.strictEqual(wat.test_call_DrawTextA(hdc, escaped, 4, calc, 0x400), 8);
  assert.strictEqual(wat.guest_read32(calc + 8), 24,
    'DrawText must collapse an escaped ampersand to one visible glyph');
  writeRect(calc, 0, 0, 80, 20);
  assert.strictEqual(wat.test_call_DrawTextA(hdc, prefixed, 3, calc, 0x400 | 0x800), 8);
  assert.strictEqual(wat.guest_read32(calc + 8), 24,
    'DT_NOPREFIX must render ampersands literally');

  const tabbed = writeAnsi('A\tA');
  writeRect(calc, 0, 0, 90, 20);
  assert.strictEqual(wat.test_call_DrawTextA(hdc, tabbed, 3, calc, 0x400 | 0x40), 8);
  assert.strictEqual(wat.guest_read32(calc + 8), 72,
    'DT_EXPANDTABS must advance to the default eight-cell tab stop');

  const ellipsis = writeAnsi('AAAAAA', 8);
  const ellipsisRect = allocZero(16);
  writeRect(ellipsisRect, 0, 0, 32, 12);
  clear();
  assert.strictEqual(wat.test_call_DrawTextA(
    hdc, ellipsis, 6, ellipsisRect, 0x20 | 0x8000 | 0x10000), 8);
  assert.strictEqual(Buffer.from(bytes.subarray(wa(ellipsis), wa(ellipsis) + 4)).toString('latin1'), 'A...',
    'DT_END_ELLIPSIS|DT_MODIFYSTRING must expose the shortened string');
  const ellipsisInk = Array.from({ length: 40 }, (_, x) => pixel(x, 3) === 0 ? x : -1)
    .filter(x => x >= 0);
  assert.strictEqual(pixel(31, 3), 0,
    `ellipsis must fill the available four glyph cells (ink: ${ellipsisInk.join(',')})`);
  assert.strictEqual(pixel(32, 3), 0xffffff, 'ellipsis must stay inside the DrawText rectangle');

  const pathEllipsis = writeAnsi('AA\\AA', 8);
  assert.strictEqual(wat.test_call_DrawTextA(
    hdc, pathEllipsis, 5, ellipsisRect, 0x20 | 0x4000 | 0x10000), 8);
  assert.strictEqual(
    Buffer.from(bytes.subarray(wa(pathEllipsis), wa(pathEllipsis) + 6)).toString('latin1'),
    '...\\AA', 'DT_PATH_ELLIPSIS must preserve the final slash and path tail');

  const wordEllipsis = writeAnsi('AAAAAA', 8);
  assert.strictEqual(wat.test_call_DrawTextA(
    hdc, wordEllipsis, 6, ellipsisRect, 0x20 | 0x40000 | 0x10000), 8);
  assert.strictEqual(
    Buffer.from(bytes.subarray(wa(wordEllipsis), wa(wordEllipsis) + 4)).toString('latin1'),
    'A...', 'DT_WORD_ELLIPSIS must shorten an overflowing single line');

  const textAA = writeAnsi('AA');
  const paired = allocZero(16);
  wat.guest_write32(paired, 12);
  wat.guest_write32(paired + 4, 4);
  wat.guest_write32(paired + 8, 12);
  wat.guest_write32(paired + 12, -2);
  clear();
  assert.strictEqual(wat.test_call_ExtTextOutAWithDx(
    hdc, 0, 0, 0x2000, 0, textAA, 2, paired), 1);
  assert.strictEqual(pixel(3, 3), 0, 'ETO_PDY must render the first glyph at the origin');
  assert.strictEqual(pixel(15, 3), 0xffffff, 'ETO_PDY must not leave the second glyph on the first baseline');
  assert.strictEqual(pixel(15, 7), 0, 'ETO_PDY must apply the paired vertical advance');

  wat.test_gdi_dc_set_field(hdc, 32, 1, 0); // TA_LEFT | TA_TOP | TA_UPDATECP
  wat.test_gdi_current_pos_set(hdc, 4, 20);
  clear();
  assert.strictEqual(wat.test_call_ExtTextOutAWithDx(
    hdc, 70, 40, 0x2000, 0, textAA, 2, paired), 1);
  assert.strictEqual(pixel(5, 21), 0, 'TA_UPDATECP must ignore the explicit ExtTextOut origin');
  assert.strictEqual(pixel(71, 41), 0xffffff);
  assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 12, 0), 28,
    'TA_UPDATECP must store the final paired X advance');
  assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 16, 0), 22,
    'TA_UPDATECP must store the final paired Y advance');

  assert.strictEqual(wat.test_call_RemoveFontResourceA(path), 1);
  console.log('PASS  WAT bitmap text honors prefixes, tabs, ellipsis, ETO_PDY, and TA_UPDATECP');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
