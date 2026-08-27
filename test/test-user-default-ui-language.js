#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_user_default_ui_language") (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetUserDefaultUILanguage
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const result = e.test_user_default_ui_language();
  assert.strictEqual(Number(result & 0xffffffffn), 0x0409,
    'default UI language is English (United States)');
  assert.strictEqual(Number(result >> 32n), 0x00300004,
    'zero-argument stdcall pops only its return address');
  console.log('PASS GetUserDefaultUILanguage matches the en-US process locale');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
