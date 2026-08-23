#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_find_first_a") (param $path i32) (result i64)
    (global.set $image_base (i32.const 0))
    (global.set $last_error (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_FindFirstFileA (local.get $path) (i32.const 0x2800)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $last_error)) (i64.const 32))))
  (func (export "test_find_first_w") (param $path i32) (result i64)
    (global.set $image_base (i32.const 0))
    (global.set $last_error (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_FindFirstFileW (local.get $path) (i32.const 0x2a00)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $last_error)) (i64.const 32))))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const narrow = 0x2600;
  const wide = 0x2700;
  const missing = 'C:\\definitely-missing-find-first-file.txt';
  for (let i = 0; i < missing.length; i++) {
    wat.guest_write8(narrow + i, missing.charCodeAt(i));
    wat.guest_write16(wide + i * 2, missing.charCodeAt(i));
  }
  wat.guest_write8(narrow + missing.length, 0);
  wat.guest_write16(wide + missing.length * 2, 0);

  for (const [name, result] of [
    ['FindFirstFileA', wat.test_find_first_a(narrow)],
    ['FindFirstFileW', wat.test_find_first_w(wide)],
  ]) {
    assert.strictEqual(Number(result & 0xffffffffn), 0xffffffff,
      `${name} returns INVALID_HANDLE_VALUE for a missing path`);
    assert.strictEqual(Number(result >> 32n), 2,
      `${name} sets ERROR_FILE_NOT_FOUND for a missing path`);
  }
  console.log('PASS  FindFirstFileA/W set ERROR_FILE_NOT_FOUND on a missing path');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
