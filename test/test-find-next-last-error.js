#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func $test_find_next (param $handle i32) (param $wide i32) (result i64)
    (global.set $last_error (i32.const 0x1234))
    (global.set $esp (i32.const 0x00300000))
    (if (local.get $wide)
      (then (call $handle_FindNextFileW
        (local.get $handle) (i32.const 0x2800)
        (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_FindNextFileA
        (local.get $handle) (i32.const 0x2800)
        (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $last_error)) (i64.const 32))))
  (func (export "test_find_next_a") (param $handle i32) (result i64)
    (call $test_find_next (local.get $handle) (i32.const 0)))
  (func (export "test_find_next_w") (param $handle i32) (result i64)
    (call $test_find_next (local.get $handle) (i32.const 1)))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({
    extraWat,
    extraHostOverrides: {
      fs_find_next_file: handle => handle === 1 ? 1 : 0,
    },
  });

  for (const [name, call] of [
    ['FindNextFileA', wat.test_find_next_a],
    ['FindNextFileW', wat.test_find_next_w],
  ]) {
    const success = BigInt.asUintN(64, call(1));
    assert.strictEqual(Number(success & 0xffffffffn), 1, `${name} returns success`);
    assert.strictEqual(Number(success >> 32n), 0x1234,
      `${name} leaves last error unspecified on success`);

    const exhausted = BigInt.asUintN(64, call(2));
    assert.strictEqual(Number(exhausted & 0xffffffffn), 0, `${name} returns false at end`);
    assert.strictEqual(Number(exhausted >> 32n), 18,
      `${name} sets ERROR_NO_MORE_FILES at end`);
  }
  console.log('PASS FindNextFileA/W report ERROR_NO_MORE_FILES on exhaustion');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
