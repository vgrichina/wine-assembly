#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_call_GetWindowLongA_exstyle")
    (param $hwnd i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetWindowLongA
      (local.get $hwnd) (i32.const -20) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_SetWindowLongA_exstyle")
    (param $hwnd i32) (param $ex i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_SetWindowLongA
      (local.get $hwnd) (i32.const -20) (local.get $ex)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_GetWindowLongW_exstyle")
    (param $hwnd i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetWindowLongW
      (local.get $hwnd) (i32.const -20) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  ;; Stands in for the CreateWindowExA path, which records dwExStyle here.
  (func (export "test_set_creation_exstyle") (param $hwnd i32) (param $ex i32)
    (call $ctrl_set_ex_style (local.get $hwnd) (local.get $ex)))
`;

const WS_EX_CLIENTEDGE = 0x00000200;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_TOPMOST = 0x00000008;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat });
  const child = e.test_create_edit(0, 0, 40, 20, 0x50000000, 0) >>> 0;

  assert.strictEqual(e.test_call_GetWindowLongA_exstyle(child), 0,
    'a window created without extended styles reports none');

  e.test_set_creation_exstyle(child, WS_EX_CLIENTEDGE);
  assert.strictEqual(e.test_call_GetWindowLongA_exstyle(child) >>> 0, WS_EX_CLIENTEDGE,
    'GetWindowLongA(GWL_EXSTYLE) reports the creation-time extended style');
  assert.strictEqual(e.test_call_GetWindowLongW_exstyle(child) >>> 0, WS_EX_CLIENTEDGE,
    'the W entry point answers the same value');

  // The read-modify-write an app performs to add a bit: it only preserves the
  // window's existing styles if the read reports them.
  const previous = e.test_call_SetWindowLongA_exstyle(
    child, WS_EX_CLIENTEDGE | WS_EX_TOOLWINDOW) >>> 0;
  assert.strictEqual(previous, WS_EX_CLIENTEDGE,
    'SetWindowLongA(GWL_EXSTYLE) returns the previous extended style');
  assert.strictEqual(e.test_call_GetWindowLongA_exstyle(child) >>> 0,
    WS_EX_CLIENTEDGE | WS_EX_TOOLWINDOW,
    'the replacement extended style is observable');

  assert.strictEqual(e.test_call_SetWindowLongA_exstyle(child, WS_EX_TOPMOST) >>> 0,
    WS_EX_CLIENTEDGE | WS_EX_TOOLWINDOW,
    'a second write returns the value the first one stored');
  assert.strictEqual(e.test_call_GetWindowLongA_exstyle(child) >>> 0, WS_EX_TOPMOST,
    'a write replaces the extended style rather than merging into it');

  assert.strictEqual(e.test_call_GetWindowLongA_exstyle(0x7FFFFFFF), 0,
    'an unknown window reports no extended style');

  console.log('PASS  GWL_EXSTYLE round-trips through Get/SetWindowLong');
})();
