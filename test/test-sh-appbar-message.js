#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_SHAppBarMessage")
      (param $message i32) (param $data i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SHAppBarMessage
      (local.get $message) (local.get $data)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({
    extraWat,
    width: 800,
    height: 600,
    fonts: 'none',
  });
  const data = wat.guest_alloc(36) >>> 0;

  wat.guest_write32(data, 36);
  for (let offset = 4; offset < 36; offset += 4) {
    wat.guest_write32(data + offset, 0xdeadbeef);
  }
  assert.strictEqual(wat.test_SHAppBarMessage(5, data), 1,
    'ABM_GETTASKBARPOS succeeds with a complete APPBARDATA');
  assert.deepStrictEqual([
    wat.guest_read32(data + 16),
    wat.guest_read32(data + 20),
    wat.guest_read32(data + 24),
    wat.guest_read32(data + 28),
  ], [0, 572, 800, 600], 'taskbar occupies the classic bottom 28 pixels');
  assert.strictEqual(wat.guest_read32(data + 12) >>> 0, 0xdeadbeef,
    'ABM_GETTASKBARPOS ignores non-RECT APPBARDATA members');
  assert.strictEqual(wat.get_esp(), 0x0030000c,
    'two-argument SHAppBarMessage preserves stdcall cleanup');

  wat.guest_write32(data, 35);
  wat.guest_write32(data + 16, 0x12345678);
  assert.strictEqual(wat.test_SHAppBarMessage(5, data), 0,
    'undersized APPBARDATA fails');
  assert.strictEqual(wat.guest_read32(data + 16) >>> 0, 0x12345678,
    'a failed call leaves the output rectangle untouched');
  assert.strictEqual(wat.test_SHAppBarMessage(5, 0), 0,
    'a null APPBARDATA fails');

  console.log('PASS SHAppBarMessage reports the Win98 taskbar rectangle');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
