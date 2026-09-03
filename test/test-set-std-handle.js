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
  (func (export "test_get_std_handle") (param $which i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetStdHandle
      (local.get $which) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_set_console_key_state") (param $state i32)
    (i32.store (region.addr $CONSOLE_INPUT 24) (local.get $state)))
  (func (export "test_get_console_key_state") (result i32)
    (i32.load (region.addr $CONSOLE_INPUT 24)))
  (func (export "test_last_error") (result i32)
    (global.get $last_error))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  assert.strictEqual(wat.test_get_std_handle(0xfffffff6), 1, 'stdin default changed');
  assert.strictEqual(wat.test_get_std_handle(0xfffffff5), 2, 'stdout default changed');
  assert.strictEqual(wat.test_get_std_handle(0xfffffff4), 3, 'stderr default changed');

  wat.test_set_console_key_state(0x1f3);
  assert.strictEqual(wat.test_set_std_handle(0xfffffff6, 0x12345678), 1,
    'redirecting STD_INPUT_HANDLE failed');
  assert.strictEqual(wat.test_set_std_handle(0xfffffff5, 0), 1,
    'setting STD_OUTPUT_HANDLE to NULL failed');
  assert.strictEqual(wat.test_set_std_handle(0xfffffff4, 0xffffffff), 1,
    'setting STD_ERROR_HANDLE to INVALID_HANDLE_VALUE failed');
  assert.strictEqual(wat.get_esp(), 0x0030000c,
    'two-argument stdcall pops return address plus arguments');
  assert.strictEqual(wat.test_get_std_handle(0xfffffff6) >>> 0, 0x12345678);
  assert.strictEqual(wat.test_get_std_handle(0xfffffff5), 0);
  assert.strictEqual(wat.test_get_std_handle(0xfffffff4) >>> 0, 0xffffffff);
  assert.strictEqual(wat.test_get_console_key_state(), 0x1f3,
    'standard-handle redirection corrupted console modifier/toggle state');

  assert.strictEqual(wat.test_set_std_handle(0xfffffff3, 7), 0,
    'unknown standard-handle selector succeeded');
  assert.strictEqual(wat.test_last_error(), 6,
    'unknown standard-handle selector did not set ERROR_INVALID_HANDLE');

  console.log('PASS process standard handles redirect independently of console key state');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
