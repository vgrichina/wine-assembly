#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_register_hotkey") (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_RegisterHotKey
      (i32.const 0x20001) (i32.const 7) (i32.const 8) (i32.const 0x5b)
      (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
  (func (export "test_unregister_hotkey") (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_UnregisterHotKey
      (i32.const 0x20001) (i32.const 7)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const registered = wat.test_register_hotkey();
  assert.strictEqual(Number(registered & 0xffffffffn), 1);
  assert.strictEqual(Number(registered >> 32n), 0x00300014,
    'RegisterHotKey pops four stdcall arguments and its return address');
  const unregistered = wat.test_unregister_hotkey();
  assert.strictEqual(Number(unregistered & 0xffffffffn), 1);
  assert.strictEqual(Number(unregistered >> 32n), 0x0030000c,
    'UnregisterHotKey pops two stdcall arguments and its return address');
  console.log('PASS  RegisterHotKey and UnregisterHotKey accept desktop-local shortcuts');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
