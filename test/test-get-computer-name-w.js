#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_computer_name_w") (param $buf i32) (param $size i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetComputerNameW (local.get $buf) (local.get $size)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_get_user_name_w") (param $buf i32) (param $size i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetUserNameW (local.get $buf) (local.get $size)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const buffer = 0x2800;
  const size = 0x2900;
  const read16 = address => e.guest_read8(address) |
    (e.guest_read8(address + 1) << 8);
  const read32 = address => e.guest_read8(address) |
    (e.guest_read8(address + 1) << 8) |
    (e.guest_read8(address + 2) << 16) |
    (e.guest_read8(address + 3) << 24);
  const write32 = (address, value) => {
    for (let i = 0; i < 4; i++) e.guest_write8(address + i, value >>> (i * 8));
  };

  write32(size, 3);
  assert.strictEqual(e.test_get_computer_name_w(buffer, size), 1,
    'three-WCHAR buffer succeeds');
  assert.deepStrictEqual([read16(buffer), read16(buffer + 2), read16(buffer + 4)],
    [0x50, 0x43, 0], 'result is UTF-16 PC with a terminator');
  assert.strictEqual(read32(size), 2, 'success excludes the terminator from the size');
  assert.strictEqual(e.get_esp(), 0x0030000c, 'two-argument stdcall pops return plus args');

  for (let i = 0; i < 6; i++) e.guest_write8(buffer + i, 0xcc);
  write32(size, 2);
  assert.strictEqual(e.test_get_computer_name_w(buffer, size), 0,
    'short buffer fails');
  assert.strictEqual(read32(size), 3, 'failure reports the required count including NUL');
  for (let i = 0; i < 6; i++) {
    assert.strictEqual(e.guest_read8(buffer + i), 0xcc,
      'short buffer is not partially overwritten');
  }

  write32(size, 5);
  assert.strictEqual(e.test_get_user_name_w(buffer, size), 1,
    'five-WCHAR user buffer succeeds');
  assert.deepStrictEqual(Array.from({ length: 5 }, (_, i) => read16(buffer + i * 2)),
    [0x75, 0x73, 0x65, 0x72, 0], 'user result is UTF-16 and terminated');
  assert.strictEqual(read32(size), 5, 'user-name success size includes the terminator');

  write32(size, 4);
  assert.strictEqual(e.test_get_user_name_w(buffer, size), 0,
    'short user buffer fails');
  assert.strictEqual(read32(size), 5,
    'user-name failure reports the required count including NUL');

  console.log('PASS Unicode machine/user identity and size contracts');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
