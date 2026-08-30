#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const EXTRA_WAT = `
  (func (export "test_native_override") (param $name_wa i32) (result i32)
    (call $native_override_export_api_id (local.get $name_wa)))
  (func (export "test_ftol") (param $value f64) (param $cw i32) (result i64)
    (global.set $fpu_cw (local.get $cw))
    (global.set $esp (i32.const 0x07600000))
    (call $fpu_push (local.get $value))
    (call $handle__ftol
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
  (func (export "test_ftol_cw") (result i32) (global.get $fpu_cw))
  (func (export "test_ftol_esp") (result i32) (global.get $esp))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({
    extraWat: EXTRA_WAT,
    fonts: 'none',
  });
  const bytes = new Uint8Array(memory.buffer);
  const nameGuest = e.guest_alloc(64) >>> 0;
  const nameWasm = e.guest_to_wasm(nameGuest) >>> 0;
  const writeName = name => {
    bytes.fill(0, nameWasm, nameWasm + 64);
    bytes.set(Buffer.from(name, 'ascii'), nameWasm);
  };

  writeName('_ftol');
  assert.strictEqual(e.test_native_override(nameWasm), 759,
    'loaded MSVCRT _ftol remains on the native API thunk');
  writeName('malloc');
  assert.strictEqual(e.test_native_override(nameWasm), -1,
    'allocator ownership remains with authentic MSVCRT');

  const bits = value => BigInt.asUintN(64, e.test_ftol(value, 0x027f));
  assert.strictEqual(bits(255.99), 255n, 'positive value truncates toward zero');
  assert.strictEqual(bits(-255.99), BigInt.asUintN(64, -255n),
    'negative value truncates toward zero');
  assert.strictEqual(bits(0x100000002), 0x100000002n,
    'full EDX:EAX result is returned');
  assert.strictEqual(bits(Number.NaN), 0x8000000000000000n,
    'NaN produces x87 integer-indefinite');
  assert.strictEqual(bits(Infinity), 0x8000000000000000n,
    'overflow produces x87 integer-indefinite');
  assert.strictEqual(e.test_ftol_cw(), 0x027f,
    'caller x87 control word is restored');
  assert.strictEqual(e.test_ftol_esp() >>> 0, 0x07600004,
    'cdecl helper removes only its return address');

  console.log('PASS  native MSVCRT _ftol preserves x87 and EDX:EAX semantics');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
