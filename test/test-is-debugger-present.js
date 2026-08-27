#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_is_debugger_present") (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IsDebuggerPresent
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const result = e.test_is_debugger_present();
  assert.strictEqual(Number(result & 0xffffffffn), 0, 'no debugger is reported');
  assert.strictEqual(Number(result >> 32n), 0x00300004,
    'zero-argument stdcall pops only the thunk return address');
  console.log('PASS IsDebuggerPresent reports the normal unattached process state');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
