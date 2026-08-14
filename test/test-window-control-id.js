#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_call_SetWindowLongA_id")
    (param $hwnd i32) (param $id i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_SetWindowLongA
      (local.get $hwnd) (i32.const -12) (local.get $id)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_GetDlgCtrlID")
    (param $hwnd i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetDlgCtrlID
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_GetWindowLongA_id")
    (param $hwnd i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetWindowLongA
      (local.get $hwnd) (i32.const -12) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_GetDlgItem_id")
    (param $parent i32) (param $id i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetDlgItem
      (local.get $parent) (local.get $id) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat });
  const child = e.test_create_edit(0, 0, 40, 20, 0x50000000, 0) >>> 0;
  const parent = e.wnd_get_parent(child) >>> 0;

  assert.strictEqual(e.test_call_GetDlgCtrlID(child), 100,
    'new child starts with its creation-time control ID');
  assert.strictEqual(e.test_call_GetWindowLongA_id(child), 100,
    'GetWindowLongA(GWL_ID) returns the creation-time control ID');
  assert.strictEqual(e.test_call_GetDlgItem_id(parent, 100) >>> 0, child,
    'parent resolves the original child ID');

  assert.strictEqual(e.test_call_SetWindowLongA_id(child, 0xEA21), 100,
    'SetWindowLongA(GWL_ID) returns the previous child ID');
  assert.strictEqual(e.test_call_GetDlgCtrlID(child), 0xEA21,
    'GetDlgCtrlID observes the replacement child ID');
  assert.strictEqual(e.test_call_GetWindowLongA_id(child), 0xEA21,
    'GetWindowLongA(GWL_ID) observes the replacement child ID');
  assert.strictEqual(e.test_call_GetDlgItem_id(parent, 100), 0,
    'the old child ID no longer resolves');
  assert.strictEqual(e.test_call_GetDlgItem_id(parent, 0xEA21) >>> 0, child,
    'the replacement child ID resolves to the saved view');

  assert.strictEqual(e.test_call_SetWindowLongA_id(0x7FFFFFFF, 1), 0,
    'an invalid window is not assigned a control ID');
  assert.strictEqual(e.test_call_GetWindowLongA_id(0x7FFFFFFF), 0,
    'an invalid window returns zero without inventing a control ID');

  console.log('PASS  SetWindowLongA(GWL_ID) updates child lookup atomically');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
