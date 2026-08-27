#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_extract_icon_ex_w") (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_ExtractIconExW
      (i32.const 0x2800) (i32.const 0) (i32.const 0x2900)
      (i32.const 0x2a00) (i32.const 1) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const result = e.test_extract_icon_ex_w();
  assert.strictEqual(Number(result & 0xffffffffn), 0,
    'unsupported icon extraction reports zero extracted icons');
  assert.strictEqual(Number(result >> 32n), 0x00300018,
    'five-argument stdcall pops return plus arguments');
  console.log('PASS ExtractIconExW shares the bounded zero-icon contract');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
