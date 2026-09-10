#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const TEXT = 'Wide iii WWW proportional text';
const extraWat = String.raw`
  (func (export "test_call_GetTextExtentPointA")
        (param i32 i32 i32 i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetTextExtentPointA
      (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
  (func (export "test_call_GetTextExtentPointW")
        (param i32 i32 i32 i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetTextExtentPointW
      (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
  (func (export "test_call_GetTextExtentPoint32W")
        (param i32 i32 i32 i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetTextExtentPoint32W
      (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', '09a4-handlers-gdi.wat'), 'utf8');
function watFunction(name) {
  const start = source.indexOf(`(func $${name}`);
  assert(start >= 0, `missing ${name}`);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

for (const suffix of ['A', 'W']) {
  const legacy = watFunction(`handle_GetTextExtentPoint${suffix}`);
  assert(legacy.includes(`call $handle_GetTextExtentPoint32${suffix}`),
    `legacy ${suffix} entry point must delegate to the 32-bit canonical handler`);
  assert(!legacy.includes('$host_measure_text'),
    `legacy ${suffix} entry point must not retain a second measurement body`);
}

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat });
  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const wa = guest => (guest - (e.get_image_base() >>> 0) + (e.get_guest_base() >>> 0)) >>> 0;
  const alloc = size => {
    const g = e.guest_alloc(size) >>> 0;
    u8.fill(0, wa(g), wa(g) + size);
    return g;
  };
  const ansi = alloc(TEXT.length + 1);
  u8.set(Buffer.from(TEXT, 'latin1'), wa(ansi));
  const wide = alloc((TEXT.length + 1) * 2);
  for (let i = 0; i < TEXT.length; i++) dv.setUint16(wa(wide) + i * 2, TEXT.charCodeAt(i), true);
  const face = alloc(12);
  for (let i = 0; i < 5; i++) dv.setUint16(wa(face) + i * 2, 'Arial'.charCodeAt(i), true);

  const hdc = e.test_call_CreateCompatibleDC(0) >>> 0;
  const font = e.test_call_CreateFontW(-18, 400, 0, face) >>> 0;
  assert.ok(hdc && font, 'test needs a proportional-font memory DC');
  e.test_call_SelectObject(hdc, font);

  const sizeA = alloc(8);
  const sizeW = alloc(8);
  assert.strictEqual(e.test_call_GetTextExtentPoint32A(hdc, ansi, TEXT.length, sizeA), 1);
  const expectedWidth = dv.getInt32(wa(sizeA), true);
  const expectedHeight = dv.getInt32(wa(sizeA) + 4, true);

  u8.fill(0, wa(sizeA), wa(sizeA) + 8);
  assert.strictEqual(e.test_call_GetTextExtentPointA(hdc, ansi, TEXT.length, sizeA), 1);
  assert.deepStrictEqual(
    [dv.getInt32(wa(sizeA), true), dv.getInt32(wa(sizeA) + 4, true)],
    [expectedWidth, expectedHeight],
    'GetTextExtentPointA delegates without changing measured ANSI glyph extents');

  assert.strictEqual(e.test_call_GetTextExtentPointW(hdc, wide, TEXT.length, sizeW), 1);
  assert.deepStrictEqual(
    [dv.getInt32(wa(sizeW), true), dv.getInt32(wa(sizeW) + 4, true)],
    [expectedWidth, expectedHeight],
    'GetTextExtentPointW uses real wide glyph measurement');

  u8.fill(0, wa(sizeW), wa(sizeW) + 8);
  assert.strictEqual(e.test_call_GetTextExtentPoint32W(hdc, wide, TEXT.length, sizeW), 1);
  assert.deepStrictEqual(
    [dv.getInt32(wa(sizeW), true), dv.getInt32(wa(sizeW) + 4, true)],
    [expectedWidth, expectedHeight],
    'GetTextExtentPoint32W uses real wide glyph measurement');
  console.log('PASS GetTextExtentPointW/32W match measured proportional ANSI glyph extents');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
