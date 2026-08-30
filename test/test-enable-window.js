#!/usr/bin/env node
'use strict';

// Win32 EnableWindow returns whether the target was disabled before the call.
// COMCTL32 uses that result to decide whether its modal property sheet owns the
// corresponding re-enable. DestroyWindow itself must not guess from ownership.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_create_dialog") (param $owner i32) (result i32)
    (local $hwnd i32)
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (local.get $hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_DIALOG))
    (call $wnd_set_owner (local.get $hwnd) (local.get $owner))
    (drop (call $wnd_set_style (local.get $hwnd) (i32.const 0x90000000)))
    (local.get $hwnd))

  (func (export "test_call_EnableWindow") (param $hwnd i32) (param $enable i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_EnableWindow
      (local.get $hwnd) (local.get $enable)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DestroyWindow") (param $hwnd i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DestroyWindow
      (local.get $hwnd) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const owner = e.test_create_dialog(0) >>> 0;

  assert.strictEqual(e.test_call_EnableWindow(owner, 0), 0,
    'disabling an enabled window reports that it was not previously disabled');
  assert(e.wnd_get_style_export(owner) & 0x08000000,
    'disabling sets WS_DISABLED');
  assert.strictEqual(e.test_call_EnableWindow(owner, 0), 1,
    'disabling an already-disabled window reports its previous disabled state');
  assert.strictEqual(e.test_call_EnableWindow(owner, 1), 1,
    'enabling a disabled window reports its previous disabled state');
  assert.strictEqual(e.wnd_get_style_export(owner) & 0x08000000, 0,
    'enabling clears WS_DISABLED');
  assert.strictEqual(e.test_call_EnableWindow(owner, 1), 0,
    'enabling an already-enabled window reports that it was not disabled');

  e.test_call_EnableWindow(owner, 0);
  const modeless = e.test_create_dialog(owner) >>> 0;
  assert.strictEqual(e.test_call_DestroyWindow(modeless), 1,
    'owned modeless dialog is destroyed');
  assert(e.wnd_get_style_export(owner) & 0x08000000,
    'destroying an owned dialog does not override an application-disabled owner');

  console.log('PASS  EnableWindow reports prior disabled state without owner heuristics');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
