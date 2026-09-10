#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: e } = await bootRenderHarness({ fonts: 'none', extraWat: `
    (func (export "test_power") (param $p i32) (result i32)
      (global.set $esp (i32.const 0x00300000))
      (call $handle_GetSystemPowerStatus (local.get $p) (i32.const 0)
        (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
      (global.get $eax))
    (func (export "test_last_error") (result i32) (global.get $last_error))
  ` });
  const ptr = 0x00403004;
  e.guest_write32(ptr - 4, 0xdeadbeef); e.guest_write32(ptr + 12, 0xdeadbeef);
  assert.strictEqual(e.test_power(ptr), 1);
  assert.strictEqual(e.get_esp(), 0x00300008);
  assert.deepStrictEqual(Array.from({ length: 4 }, (_, i) => e.guest_read8(ptr + i)),
    [1, 128, 255, 0], 'AC online, absent battery, unknown percentage, reserved zero');
  assert.strictEqual(e.guest_read32(ptr + 4) >>> 0, 0xffffffff);
  assert.strictEqual(e.guest_read32(ptr + 8) >>> 0, 0xffffffff);
  assert.strictEqual(e.guest_read32(ptr - 4) >>> 0, 0xdeadbeef);
  assert.strictEqual(e.guest_read32(ptr + 12) >>> 0, 0xdeadbeef);
  assert.strictEqual(e.test_power(0), 0);
  assert.strictEqual(e.test_last_error(), 87);
  assert.strictEqual(e.get_esp(), 0x00300008);
  console.log('PASS GetSystemPowerStatus structure, boundaries and stdcall ABI');
})().catch(error => { console.error(error); process.exitCode = 1; });
