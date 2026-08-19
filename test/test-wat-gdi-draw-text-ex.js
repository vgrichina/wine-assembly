#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_call_DrawTextExA")
        (param i32 i32 i32 i32 i32 i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $gs32 (i32.add (local.get $saved_esp) (i32.const 24)) (local.get 5))
    (call $handle_DrawTextExA
      (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
  (func (export "test_call_DrawTextExW")
        (param i32 i32 i32 i32 i32 i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $gs32 (i32.add (local.get $saved_esp) (i32.const 24)) (local.get 5))
    (call $handle_DrawTextExW
      (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))`;

(async () => {
  const { exports: wat, memory, hostCtx } = await bootRenderHarness({ extraWat });
  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const writeAnsi = value => {
    const pointer = allocZero(value.length + 1);
    bytes.set(Buffer.from(value, 'latin1'), wa(pointer));
    return pointer;
  };
  const writeWide = value => {
    const pointer = allocZero((value.length + 1) * 2);
    [...value].forEach((character, index) =>
      wat.guest_write16(pointer + index * 2, character.charCodeAt(0)));
    return pointer;
  };
  const writeRect = (pointer, left, top, right, bottom) => {
    wat.guest_write32(pointer, left);
    wat.guest_write32(pointer + 4, top);
    wat.guest_write32(pointer + 8, right);
    wat.guest_write32(pointer + 12, bottom);
  };
  const writeParams = (pointer, size, tabs, left, right, drawn = 0xdeadbeef) => {
    wat.guest_write32(pointer, size);
    wat.guest_write32(pointer + 4, tabs);
    wat.guest_write32(pointer + 8, left);
    wat.guest_write32(pointer + 12, right);
    wat.guest_write32(pointer + 16, drawn);
  };

  const fnt = Buffer.alloc(143);
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
  fnt.write('ExParams\0', 134, 'latin1');
  hostCtx.vfs.files.set('c:\\exparams.fon', { data: new Uint8Array(fnt), attrs: 0x20 });
  const fontPath = writeAnsi('EXPARAMS.FON');
  assert.strictEqual(wat.test_call_AddFontResourceA(fontPath), 1);

  const width = 128;
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
  const face = writeWide('ExParams');
  const font = wat.test_call_CreateFontW(-8, 400, 0, face) >>> 0;
  wat.test_call_SelectObject(hdc, font);
  wat.test_gdi_dc_set_field(hdc, 28, 1, 2); // TRANSPARENT
  wat.test_gdi_dc_set_field(hdc, 20, 0x000000, 0); // black
  assert.strictEqual(wat.test_call_PatBlt(hdc, 0, 0, width, height, 0x00F00021), 1);

  const rect = allocZero(16);
  const params = allocZero(20);
  const ansi = writeAnsi('AA');
  writeRect(rect, 0, 0, 80, 16);
  writeParams(params, 20, 0, 8, 16);
  assert.strictEqual(wat.test_call_DrawTextExA(hdc, ansi, 2, rect, 0, params), 8);
  assert.deepStrictEqual([0, 4, 8, 12].map(offset => wat.guest_read32(rect + offset)),
    [0, 0, 80, 16], 'non-CALCRECT calls must restore the caller rectangle');
  assert.strictEqual(wat.guest_read32(params + 16), 2, 'uiLengthDrawn for explicit ANSI count');
  const dibBits = wat.guest_read32(bitsOut) >>> 0;
  const pixel = (x, y) => wat.guest_read32(dibBits + (y * width + x) * 4) & 0xffffff;
  assert.strictEqual(pixel(3, 3), 0xffffff, 'left margin must remain blank');
  assert.strictEqual(pixel(11, 3), 0, 'text must begin inside the left margin');

  writeRect(rect, 0, 0, 100, 20);
  writeParams(params, 20, 0, 8, 16);
  assert.strictEqual(wat.test_call_DrawTextExA(hdc, ansi, 2, rect, 0x400, params), 8);
  assert.deepStrictEqual([0, 4, 8, 12].map(offset => wat.guest_read32(rect + offset)),
    [0, 0, 40, 8], 'CALCRECT width must include both DrawTextEx margins');

  const tabbed = writeAnsi('A\tA');
  writeRect(rect, 0, 0, 100, 20);
  writeParams(params, 20, 2, 0, 0);
  assert.strictEqual(wat.test_call_DrawTextExA(hdc, tabbed, -1, rect, 0x40 | 0x400, params), 8);
  assert.strictEqual(wat.guest_read32(rect + 8), 24,
    'iTabLength=2 must override the default eight-cell interval without losing CALCRECT');
  assert.strictEqual(wat.guest_read32(params + 16), 3,
    'uiLengthDrawn must resolve a null-terminated ANSI count');

  const wide = writeWide('AA');
  writeRect(rect, 0, 0, 100, 20);
  writeParams(params, 20, 0, 4, 4);
  assert.strictEqual(wat.test_call_DrawTextExW(hdc, wide, -1, rect, 0x400, params), 8);
  assert.strictEqual(wat.guest_read32(rect + 8), 24, 'wide CALCRECT must include margins');
  assert.strictEqual(wat.guest_read32(params + 16), 2,
    'uiLengthDrawn must resolve a null-terminated UTF-16 count');

  writeRect(rect, 0, 0, 100, 20);
  writeParams(params, 16, 0, 20, 20);
  assert.strictEqual(wat.test_call_DrawTextExA(hdc, ansi, 2, rect, 0x400, params), 8);
  assert.strictEqual(wat.guest_read32(rect + 8), 16, 'undersized params must be ignored');
  assert.strictEqual(wat.guest_read32(params + 16) >>> 0, 0xdeadbeef,
    'undersized params must not receive uiLengthDrawn');

  assert.strictEqual(wat.test_call_RemoveFontResourceA(fontPath), 1);
  console.log('PASS  DrawTextEx A/W honors margins, tab length, and length output');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
