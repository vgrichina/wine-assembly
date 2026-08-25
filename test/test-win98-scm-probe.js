#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_last_error") (result i32)
    (global.get $last_error))

  (func (export "test_call_OpenSCManagerA") (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_OpenSCManagerA
      (i32.const 0) (i32.const 0) (i32.const 0xF003F)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_CloseServiceHandle") (param $handle i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_CloseServiceHandle
      (local.get $handle) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat });
  assert.strictEqual(e.test_call_OpenSCManagerA(), 0,
    'Windows 98 personality does not advertise NT service management');
  assert.strictEqual(e.test_get_last_error(), 120,
    'failure reports ERROR_CALL_NOT_IMPLEMENTED');
  assert.strictEqual(e.test_call_CloseServiceHandle(0), 0);
  assert.strictEqual(e.test_call_CloseServiceHandle(0x53434d31), 1);
  console.log('PASS  Win98 SCM probe selects the non-NT installer path');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
