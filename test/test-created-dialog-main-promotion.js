#!/usr/bin/env node
'use strict';

// CreateDialogParamA can make a resource dialog visible without a later
// ShowWindow call. A retained application DLGPROC must therefore replace an
// invisible framework helper as main_hwnd and arm the normal post-init
// activation continuation at creation time.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_created_dialog_promotion") (result i64)
    (local $hidden i32) (local $dialog i32)
    (local.set $hidden (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $hidden) (global.get $WNDPROC_BUILTIN))
    (drop (call $wnd_set_style (local.get $hidden) (i32.const 0)))
    (global.set $main_hwnd (local.get $hidden))

    (local.set $dialog (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $dialog) (global.get $WNDPROC_DIALOG))
    (drop (call $wnd_set_style (local.get $dialog) (i32.const 0x80000000)))
    (call $created_dialog_promote_app_main
      (local.get $dialog) (i32.const 0x00401234))

    (i64.or
      (i64.extend_i32_u (global.get $main_hwnd))
      (i64.shl
        (i64.extend_i32_u (global.get $createwnd_implicit_show))
        (i64.const 32))))

  (func (export "test_created_owned_dialog_not_promoted") (result i32)
    (local $main i32) (local $dialog i32)
    (global.set $show_window_activated (i32.const 0))
    (global.set $createwnd_implicit_show (i32.const 0))
    (local.set $main (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $main) (global.get $WNDPROC_BUILTIN))
    (drop (call $wnd_set_style (local.get $main) (i32.const 0)))
    (global.set $main_hwnd (local.get $main))
    (local.set $dialog (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $dialog) (global.get $WNDPROC_DIALOG))
    (call $wnd_set_owner (local.get $dialog) (local.get $main))
    (call $created_dialog_promote_app_main
      (local.get $dialog) (i32.const 0x00401234))
    (i32.eq (global.get $main_hwnd) (local.get $main)))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const packed = BigInt.asUintN(64, e.test_created_dialog_promotion());
  const main = Number(packed & 0xffffffffn) >>> 0;
  const armed = Number(packed >> 32n) >>> 0;

  assert.strictEqual(main, 0x10002,
    'retained top-level dialog replaces the first hidden helper HWND');
  assert.strictEqual(armed, 1,
    'created dialog arms activation immediately after WM_INITDIALOG');
  assert.strictEqual(e.test_created_owned_dialog_not_promoted(), 1,
    'owned dialogs do not replace the application main window');

  console.log('PASS  created top-level app dialog promotes and arms activation');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
