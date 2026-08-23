#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_call_DdeConnect")
    (param $service i32) (param $topic i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DdeConnect
      (i32.const 1) (local.get $service) (local.get $topic) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DdeClientTransaction")
    (param $conv i32) (param $result_ptr i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (global.set $esp (i32.const 0x07000000))
    ;; Eighth argument pdwResult follows the return address and seven args.
    (call $gs32 (i32.const 0x07000020) (local.get $result_ptr))
    (call $handle_DdeClientTransaction
      (i32.const 0x1000) (i32.const 12) (local.get $conv)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DdeDisconnect") (param $conv i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DdeDisconnect
      (local.get $conv) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat });
  assert.strictEqual(e.test_call_DdeConnect(0, 0), 0,
    'a conversation still requires service and topic handles');
  const conv = e.test_call_DdeConnect(0x1234, 0x5678) >>> 0;
  assert.strictEqual(conv, 0xdd000001, 'Program Manager conversation is process-local');

  const result = e.guest_alloc(4) >>> 0;
  e.guest_write32(result, 0);
  assert.strictEqual(e.test_call_DdeClientTransaction(conv, result) >>> 0, 0xdd000002,
    'shortcut command transaction returns an acknowledged data handle');
  assert.strictEqual(e.guest_read32(result), 1, 'synchronous result reports success');
  assert.strictEqual(e.test_call_DdeClientTransaction(0, result), 0,
    'an invalid conversation is rejected');
  assert.strictEqual(e.test_call_DdeDisconnect(conv), 1);

  console.log('PASS  Win32 DDE acknowledges local Program Manager installer commands');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
