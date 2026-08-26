#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_set_std_handle") (param $which i32) (param $handle i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SetStdHandle
      (local.get $which) (local.get $handle) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  assert.strictEqual(wat.test_set_std_handle(0xfffffff5, 0), 1,
    'detaching STD_OUTPUT_HANDLE succeeds');
  assert.strictEqual(wat.get_esp(), 0x0030000c,
    'two-argument stdcall pops return address plus arguments');

  console.log('PASS SetStdHandle accepts virtual-console redirection');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
