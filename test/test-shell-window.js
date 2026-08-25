#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_set_shell_window") (param $hwnd i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SetShellWindow
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
  (func (export "test_get_shell_window") (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetShellWindow
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const set = wat.test_set_shell_window(0x1000f);
  assert.strictEqual(Number(set & 0xffffffffn), 1);
  assert.strictEqual(Number(set >> 32n), 0x00300008);
  const get = wat.test_get_shell_window();
  assert.strictEqual(Number(get & 0xffffffffn), 0x1000f);
  assert.strictEqual(Number(get >> 32n), 0x00300004);
  assert.strictEqual(Number(wat.test_set_shell_window(0x10010) & 0xffffffffn), 0,
    'an unrelated window cannot replace the registered shell owner');
  console.log('PASS  SetShellWindow and GetShellWindow preserve Win9x shell-owner state');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
