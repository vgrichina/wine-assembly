#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_cursor") (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetCursor
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_set_cursor") (param $cursor i32) (result i32)
    (call $set_cursor_internal (local.get $cursor)))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  assert.strictEqual(wat.test_get_cursor() >>> 0, 0x67f00,
    'GetCursor returns the default IDC_ARROW handle');
  assert.strictEqual(wat.get_esp() >>> 0, 0x00300004,
    'zero-argument stdcall pops its return address');
  assert.strictEqual(wat.test_set_cursor(0x12345678) >>> 0, 0x67f00,
    'SetCursor returns the previous cursor');
  assert.strictEqual(wat.test_get_cursor() >>> 0, 0x12345678,
    'GetCursor observes the cursor installed by SetCursor');

  console.log('PASS GetCursor returns the current cursor state');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
