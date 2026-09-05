#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_char_lower_a") (param $value i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_CharLowerA
      (local.get $value) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_char_lower_w") (param $value i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_CharLowerW
      (local.get $value) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_char_lower_buff_w") (param $value i32) (param $count i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_CharLowerBuffW
      (local.get $value) (local.get $count) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_char_lower_buff_a") (param $value i32) (param $count i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_CharLowerBuffA
      (local.get $value) (local.get $count) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const buffer = 0x12600;
  const input = 'Setup_ÄZ';
  for (let i = 0; i <= input.length; i++) {
    const code = i < input.length ? input.charCodeAt(i) : 0;
    wat.guest_write8(buffer + i * 2, code & 0xff);
    wat.guest_write8(buffer + i * 2 + 1, code >>> 8);
  }

  assert.strictEqual(wat.test_char_lower_w(buffer), buffer, 'pointer form returns its input');
  let output = '';
  for (let i = 0; i < input.length; i++) {
    const code = wat.guest_read8(buffer + i * 2) |
      (wat.guest_read8(buffer + i * 2 + 1) << 8);
    output += String.fromCharCode(code);
  }
  assert.strictEqual(output, 'setup_Äz', 'ASCII capitals fold and other UTF-16 code units remain');
  assert.strictEqual(wat.test_char_lower_w('Q'.charCodeAt(0)), 'q'.charCodeAt(0),
    'single-character form folds the low WCHAR');
  assert.strictEqual(wat.get_esp(), 0x00300008,
    'one-argument stdcall pops return address plus argument');

  // The buffer form is count-delimited, not NUL-delimited.
  wat.guest_write8(buffer, 'A'.charCodeAt(0));
  wat.guest_write8(buffer + 1, 0);
  wat.guest_write8(buffer + 2, 0);
  wat.guest_write8(buffer + 3, 0);
  wat.guest_write8(buffer + 4, 'Z'.charCodeAt(0));
  wat.guest_write8(buffer + 5, 0);
  assert.strictEqual(wat.test_char_lower_buff_w(buffer, 3), 3,
    'CharLowerBuffW returns the number of processed WCHARs');
  assert.deepStrictEqual([
    wat.guest_read8(buffer), wat.guest_read8(buffer + 2), wat.guest_read8(buffer + 4),
  ], ['a'.charCodeAt(0), 0, 'z'.charCodeAt(0)],
  'CharLowerBuffW folds through an embedded NUL for the full count');
  assert.strictEqual(wat.get_esp(), 0x0030000c,
    'two-argument stdcall pops return address plus both arguments');

  const ansi = buffer + 0x40;
  for (const [i, code] of [...Buffer.from('Setup_Z\0', 'ascii')].entries()) {
    wat.guest_write8(ansi + i, code);
  }
  assert.strictEqual(wat.test_char_lower_a(ansi), ansi,
    'CharLowerA pointer form returns its input');
  assert.deepStrictEqual(Array.from({ length: 8 }, (_, i) => wat.guest_read8(ansi + i)),
    [...Buffer.from('setup_z\0', 'ascii')],
    'CharLowerA lowercases the NUL-terminated string in place');
  assert.strictEqual(wat.test_char_lower_a('Q'.charCodeAt(0)), 'q'.charCodeAt(0),
    'CharLowerA single-character form folds only the low byte');

  for (const [i, code] of ['A'.charCodeAt(0), 0, 'Z'.charCodeAt(0)].entries()) {
    wat.guest_write8(ansi + i, code);
  }
  assert.strictEqual(wat.test_char_lower_buff_a(ansi, 3), 3,
    'CharLowerBuffA returns the number of processed bytes');
  assert.deepStrictEqual(Array.from({ length: 3 }, (_, i) => wat.guest_read8(ansi + i)),
    ['a'.charCodeAt(0), 0, 'z'.charCodeAt(0)],
    'CharLowerBuffA folds through an embedded NUL for the full count');
  assert.strictEqual(wat.test_char_lower_buff_a(0, 3), 0,
    'CharLowerBuffA rejects a NULL counted buffer');
  assert.strictEqual(wat.test_char_lower_buff_w(0, 3), 0,
    'CharLowerBuffW rejects a NULL counted buffer');

  console.log('PASS CharLowerA/W pointer/single-char and CharLowerBuffA/W counted forms');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
