#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_system_directory_w") (param $buf i32) (param $size i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetSystemDirectoryW (local.get $buf) (local.get $size)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const buffer = 0x2600;
  const expected = 'C:\\WINDOWS\\SYSTEM';
  const read16 = address => wat.guest_read8(address) |
    (wat.guest_read8(address + 1) << 8);

  for (let i = 0; i < 40; i++) wat.guest_write8(buffer + i, 0xcc);
  assert.strictEqual(wat.test_get_system_directory_w(buffer, 18), expected.length,
    'success returns the character count excluding NUL');
  for (let i = 0; i < expected.length; i++) {
    assert.strictEqual(read16(buffer + i * 2), expected.charCodeAt(i),
      `UTF-16 code unit ${i}`);
  }
  assert.strictEqual(read16(buffer + expected.length * 2), 0,
    'successful output is NUL terminated');
  assert.strictEqual(wat.get_esp(), 0x0030000c, 'two-argument stdcall pops return plus args');

  for (let i = 0; i < 40; i++) wat.guest_write8(buffer + i, 0xcc);
  assert.strictEqual(wat.test_get_system_directory_w(buffer, 17), 18,
    'short buffer returns required character count including NUL');
  for (let i = 0; i < 40; i++) {
    assert.strictEqual(wat.guest_read8(buffer + i), 0xcc,
      'short buffer is not partially overwritten');
  }
  assert.strictEqual(wat.test_get_system_directory_w(0, 0), 18,
    'size query through a null buffer reports the required size');

  console.log('PASS GetSystemDirectoryW UTF-16 output and size contract');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
