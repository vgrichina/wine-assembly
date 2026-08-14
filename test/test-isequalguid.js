#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_write_guid")
      (param $ptr i32) (param $a i32) (param $b i32)
      (param $c i32) (param $d i32)
    (call $gs32 (local.get $ptr) (local.get $a))
    (call $gs32 (i32.add (local.get $ptr) (i32.const 4)) (local.get $b))
    (call $gs32 (i32.add (local.get $ptr) (i32.const 8)) (local.get $c))
    (call $gs32 (i32.add (local.get $ptr) (i32.const 12)) (local.get $d)))
  (func (export "test_call_IsEqualGUID") (param $a i32) (param $b i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IsEqualGUID
      (local.get $a) (local.get $b) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_isequalguid_esp") (result i32)
    (global.get $esp))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const a = 0x410000;
  const b = 0x410020;
  wat.test_write_guid(a, 0x36E95EE0, 0x11CF8577, 0x80000C96, 0x824E53C7);
  wat.test_write_guid(b, 0x36E95EE0, 0x11CF8577, 0x80000C96, 0x824E53C7);

  assert.strictEqual(wat.test_call_IsEqualGUID(a, b), 1,
    'distinct pointers with identical 16-byte GUIDs compare equal');
  assert.strictEqual(wat.test_isequalguid_esp() >>> 0, 0x3000c,
    'IsEqualGUID pops its return address and two stdcall arguments');
  wat.test_write_guid(b, 0x36E95EE0, 0x11CF8577, 0x80000C96, 0x824E53C6);
  assert.strictEqual(wat.test_call_IsEqualGUID(a, b), 0,
    'a mismatch in the final GUID dword compares unequal');
  assert.strictEqual(wat.test_call_IsEqualGUID(a, a), 1,
    'identical pointers compare equal');
  assert.strictEqual(wat.test_call_IsEqualGUID(a, 0), 0,
    'a null and non-null GUID compare unequal without dereferencing null');

  console.log('PASS  IsEqualGUID compares all 16 bytes and preserves stdcall ABI');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
