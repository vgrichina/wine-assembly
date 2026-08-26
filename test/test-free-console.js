#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_free_console") (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_FreeConsole
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  assert.strictEqual(wat.test_free_console(), 1, 'FreeConsole succeeds');
  assert.strictEqual(wat.get_esp(), 0x00300004,
    'zero-argument stdcall pops its return address');

  console.log('PASS FreeConsole detaches the virtual console');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
