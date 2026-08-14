#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = `
  (func (export "test_call_DuplicateHandle")
    (param $stack i32) (param $target i32) (result i32)
    (global.set $esp (local.get $stack))
    ;; Sixth/seventh arguments: bInheritHandle=FALSE,
    ;; dwOptions=DUPLICATE_SAME_ACCESS.
    (call $gs32 (i32.add (local.get $stack) (i32.const 24)) (i32.const 0))
    (call $gs32 (i32.add (local.get $stack) (i32.const 28)) (i32.const 2))
    (call $handle_DuplicateHandle
      (i32.const -1) (i32.const -2) (i32.const -1)
      (local.get $target) (i32.const 0) (i32.const 0))
    (global.get $esp))

  (func (export "test_read_guest32") (param $address i32) (result i32)
    (call $gl32 (local.get $address)))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const stack = 0x074ff000;
  const target = 0x00490000;

  assert.strictEqual(wat.test_call_DuplicateHandle(stack, target) >>> 0, stack + 32,
    'DuplicateHandle pops its return address and seven stdcall arguments');
  assert.strictEqual(wat.get_eax(), 1, 'DuplicateHandle succeeds with an output pointer');
  assert.strictEqual(wat.test_read_guest32(target) >>> 0, 0xfffffffe,
    'DuplicateHandle copies the source pseudo-thread handle');

  assert.strictEqual(wat.test_call_DuplicateHandle(stack, 0) >>> 0, stack + 32,
    'failed DuplicateHandle still cleans up its stdcall frame');
  assert.strictEqual(wat.get_eax(), 0, 'DuplicateHandle rejects a NULL output pointer');

  console.log('PASS  DuplicateHandle copies pseudo handles and preserves stdcall cleanup');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
