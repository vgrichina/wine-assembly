#!/usr/bin/env node

'use strict';

const assert = require('assert');
const apiTable = require('../src/api_table.json');
const { bootRenderHarness } = require('./render-helper');

const extraWat = `
  (func (export "test_get_proc_imm_is_ime") (param $stack i32) (result i32)
    (local $name i32)
    (local.set $name (call $heap_alloc (i32.const 9)))
    (i32.store (call $g2w (local.get $name)) (i32.const 0x496d6d49)) ;; "ImmI"
    (i32.store offset=4 (call $g2w (local.get $name)) (i32.const 0x454d4973)) ;; "sIME"
    (i32.store8 offset=8 (call $g2w (local.get $name)) (i32.const 0))
    (global.set $esp (local.get $stack))
    (call $handle_GetProcAddress
      (global.get $image_base) (local.get $name) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_call_imm_is_ime") (param $stack i32) (param $hkl i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $handle_ImmIsIME
      (local.get $hkl) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $esp))
`;

(async () => {
  const api = apiTable.find(entry => entry.name === 'ImmIsIME');
  assert(api, 'ImmIsIME must be available to dynamic GetProcAddress callers');
  assert.strictEqual(api.nargs, 1, 'ImmIsIME has one stdcall argument');
  assert.strictEqual(apiTable.find(entry => entry.name === 'SendNotifyMessageW').nargs, 4,
    'the Inno Unicode notification path is statically dispatched');
  assert.strictEqual(apiTable.find(entry => entry.name === 'EnumFontsW').nargs, 4,
    'the Inno Unicode font enumeration path is statically dispatched');
  assert.strictEqual(apiTable.find(entry => entry.name === 'GetFileVersionInfoSizeW').nargs, 2,
    'the Inno Unicode VERSION probe is statically dispatched');
  assert.strictEqual(apiTable.find(entry => entry.name === 'GetFileVersionInfoW').nargs, 4,
    'the Inno Unicode VERSION data read is statically dispatched');
  assert.strictEqual(apiTable.find(entry => entry.name === 'VerQueryValueW').nargs, 4,
    'the Inno Unicode fixed-version query is statically dispatched');

  const { exports: wat } = await bootRenderHarness({ extraWat });
  const stack = 0x074ff000;

  assert.notStrictEqual(wat.test_get_proc_imm_is_ime(stack) >>> 0, 0,
    'GetProcAddress(ImmIsIME) returns a callable thunk');
  assert.strictEqual(wat.test_call_imm_is_ime(stack, 0x04090409) >>> 0, stack + 8,
    'ImmIsIME pops its HKL and return address');
  assert.strictEqual(wat.get_eax(), 0, 'the plain en-US HKL is not an IME');

  console.log('PASS  ImmIsIME resolves dynamically and rejects the plain en-US HKL');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
