#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_virtual_query") (param $address i32) (param $buf i32) (result i32)
    (global.set $image_base (i32.const 0x00400000))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_VirtualQuery
      (local.get $address) (local.get $buf) (i32.const 28)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const buffer = 0x00402600;
  const read32 = address => (wat.guest_read8(address) |
    (wat.guest_read8(address + 1) << 8) |
    (wat.guest_read8(address + 2) << 16) |
    (wat.guest_read8(address + 3) << 24)) >>> 0;

  assert.strictEqual(wat.test_virtual_query(0x00401234, buffer), 28,
    'a low user-space address returns MEMORY_BASIC_INFORMATION');
  assert.strictEqual(read32(buffer), 0x00401000, 'BaseAddress is page-aligned');
  assert.strictEqual(read32(buffer + 16), 0x1000, 'low region is MEM_COMMIT');
  assert.strictEqual(wat.get_esp(), 0x00300010,
    'three-argument stdcall pops return address plus arguments');

  for (let i = 0; i < 28; i++) wat.guest_write8(buffer + i, 0xcc);
  assert.strictEqual(wat.test_virtual_query(0x80000000, buffer), 0,
    'query at the first kernel-space address fails');
  for (let i = 0; i < 28; i++) {
    assert.strictEqual(wat.guest_read8(buffer + i), 0xcc,
      'failed high-address query does not overwrite the result buffer');
  }
  assert.strictEqual(wat.test_virtual_query(0xffffffff, buffer), 0,
    'top-of-address-space query fails instead of wrapping');

  console.log('PASS VirtualQuery stops at the 32-bit user-address boundary');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
