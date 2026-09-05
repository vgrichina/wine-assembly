#!/usr/bin/env node
'use strict';

const assert = require('assert');
const apiTable = require('../src/api_table.json');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (global $test_file_security_needed (mut i32) (i32.const 0))
  (global $test_file_security_stack_delta (mut i32) (i32.const 0))

  (func $test_call_GetFileSecurity (param $wide i32) (result i32)
    (local $needed i32) (local $saved_esp i32)
    (local.set $needed (call $heap_alloc (i32.const 4)))
    (call $gs32 (local.get $needed) (i32.const 0x7badf00d))
    (local.set $saved_esp (global.get $esp))
    (if (local.get $wide)
      (then
        (call $handle_GetFileSecurityW
          (i32.const 0x400000) (i32.const 4) (i32.const 0)
          (i32.const 0) (local.get $needed) (i32.const 0)))
      (else
        (call $handle_GetFileSecurityA
          (i32.const 0x400000) (i32.const 4) (i32.const 0)
          (i32.const 0) (local.get $needed) (i32.const 0))))
    (global.set $test_file_security_needed (call $gl32 (local.get $needed)))
    (global.set $test_file_security_stack_delta
      (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func $test_call_SetFileSecurity (param $wide i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (if (local.get $wide)
      (then
        (call $handle_SetFileSecurityW
          (i32.const 0x400000) (i32.const 4) (i32.const 0x410000)
          (i32.const 0) (i32.const 0) (i32.const 0)))
      (else
        (call $handle_SetFileSecurityA
          (i32.const 0x400000) (i32.const 4) (i32.const 0x410000)
          (i32.const 0) (i32.const 0) (i32.const 0))))
    (global.set $test_file_security_stack_delta
      (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_get_file_security") (param $wide i32) (result i32)
    (call $test_call_GetFileSecurity (local.get $wide)))
  (func (export "test_set_file_security") (param $wide i32) (result i32)
    (call $test_call_SetFileSecurity (local.get $wide)))
  (func (export "test_file_security_needed") (result i32)
    (global.get $test_file_security_needed))
  (func (export "test_file_security_stack_delta") (result i32)
    (global.get $test_file_security_stack_delta))
  (func (export "test_last_error") (result i32)
    (global.get $last_error))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });

  for (const [wide, suffix] of [[0, 'A'], [1, 'W']]) {
    assert.strictEqual(e.test_get_file_security(wide), 0,
      `GetFileSecurity${suffix} fails on the Win98 personality`);
    assert.strictEqual(e.test_last_error(), 120,
      `GetFileSecurity${suffix} reports ERROR_CALL_NOT_IMPLEMENTED`);
    assert.strictEqual(e.test_file_security_needed(), 0,
      `GetFileSecurity${suffix} clears lpnLengthNeeded`);
    assert.strictEqual(e.test_file_security_stack_delta(), 24,
      `GetFileSecurity${suffix} pops five stdcall arguments`);

    assert.strictEqual(e.test_set_file_security(wide), 0,
      `SetFileSecurity${suffix} does not claim an ACL was persisted`);
    assert.strictEqual(e.test_last_error(), 120,
      `SetFileSecurity${suffix} reports ERROR_CALL_NOT_IMPLEMENTED`);
    assert.strictEqual(e.test_file_security_stack_delta(), 16,
      `SetFileSecurity${suffix} pops three stdcall arguments`);
  }

  const names = new Set(apiTable.map(api => api.name));
  for (const name of ['GetFileSecurityA', 'GetFileSecurityW',
    'SetFileSecurityA', 'SetFileSecurityW']) {
    assert(names.has(name), `${name} remains resolvable by named import`);
  }

  console.log('PASS  Win98 file-security imports fail consistently without fake ACL success');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
