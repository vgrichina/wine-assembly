#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_call_MsiQueryProductStateW") (param $product i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_MsiQueryProductStateW
      (local.get $product) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  assert.strictEqual(e.test_call_MsiQueryProductStateW(0x1234), -1,
    'unknown product is not advertised or installed');
  assert.strictEqual(e.test_call_MsiQueryProductStateW(0), -2,
    'null product code is INSTALLSTATE_INVALIDARG');
  console.log('PASS empty MSI database reports unknown product state');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
