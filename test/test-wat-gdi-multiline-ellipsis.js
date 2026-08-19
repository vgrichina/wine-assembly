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
  fnt.writeUInt32LE(134, 105);
  fnt.writeUInt16LE(8, 118);
  fnt.writeUInt16LE(126, 120);
  fnt.writeUInt16LE(134, 124);
  fnt.fill(0xff, 126, 134);
  fnt.write('Multi\0', 134, 'latin1');
  hostCtx.vfs.files.set('c:\\multi.fon', { data: new Uint8Array(fnt), attrs: 0x20 });
  const fontPath = writeAnsi('MULTI.FON');
  assert.strictEqual(wat.test_call_AddFontResourceA(fontPath), 1);

  const width = 64;
  const height = 32;
  const bmi = allocZero(40);
  wat.guest_write32(bmi, 40);
  wat.guest_write32(bmi + 4, width);
  wat.guest_write32(bmi + 8, -height);
  wat.guest_write16(bmi + 12, 1);
  wat.guest_write16(bmi + 14, 32);
  const bitsOut = allocZero(4);
  const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  wat.test_call_SelectObject(hdc, bitmap);
  const face = allocZero(16);
  [...'Multi'].forEach((character, index) =>
    wat.guest_write16(face + index * 2, character.charCodeAt(0)));
  const font = wat.test_call_CreateFontW(-8, 400, 0, face) >>> 0;
  wat.test_call_SelectObject(hdc, font);
  wat.test_gdi_dc_set_field(hdc, 28, 1, 2); // TRANSPARENT
  wat.test_gdi_dc_set_field(hdc, 20, 0x000000, 0); // black
  assert.strictEqual(wat.test_call_PatBlt(hdc, 0, 0, width, height, 0x00F00021), 1);

  const rect = allocZero(16);
  writeRect(rect, 0, 0, 32, 16);
  const text = writeAnsi('AAAA AAAA AAAA', 8);
  const format = 0x10 | 0x8000 | 0x10000; // WORDBREAK | END_ELLIPSIS | MODIFYSTRING
  assert.strictEqual(wat.test_call_DrawTextA(hdc, text, 14, rect, format), 16,
    'two visible 8px rows should be returned after vertical truncation');
  assert.strictEqual(
    Buffer.from(bytes.subarray(wa(text), wa(text) + 10)).toString('latin1'),
    'AAAA A...\0', 'the final visible wrapped row should expose its ellipsis');

  const dibBits = wat.guest_read32(bitsOut) >>> 0;
  const pixel = (x, y) => wat.guest_read32(dibBits + (y * width + x) * 4) & 0xffffff;
  assert.strictEqual(pixel(31, 11), 0,
    'the second row ellipsis should occupy the final available glyph cell');
  assert.strictEqual(pixel(3, 19), 0xffffff,
    'rows hidden below the rectangle must not be rasterized');

  assert.strictEqual(wat.test_call_RemoveFontResourceA(fontPath), 1);
  console.log('PASS  multiline bitmap DrawText ellipsizes the final visible row');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
