#!/usr/bin/env node

'use strict';

// A posted application-defined dialog message must enter the x86 DLGPROC on
// the main interpreter context. Running it through the bounded synchronous
// sender loses a native nested modal stack when the callback remains live.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_dispatch_dialog_custom")
    (param $hwnd i32) (param $proc i32) (param $msg i32) (result i32)
    (global.set $image_base (i32.const 0x00400000))
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_DIALOG))
    (drop (call $dialog_proc_set (local.get $hwnd) (local.get $proc)))
    (global.set $esp (i32.const 0x00500000))
    (global.set $eip (i32.const 0x00409999))
    (call $gs32 (global.get $esp) (i32.const 0x00401234))
    (call $gs32 (i32.const 0x00510000) (local.get $hwnd))
    (call $gs32 (i32.const 0x00510004) (local.get $msg))
    (call $gs32 (i32.const 0x00510008) (i32.const 0x11223344))
    (call $gs32 (i32.const 0x0051000C) (i32.const 0x55667788))
    (call $handle_DispatchMessageA (i32.const 0x00510000)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eip))

  (func (export "test_dialog_marker_installed") (param $hwnd i32) (result i32)
    (i32.eq
      (call $wnd_table_get (local.get $hwnd))
      (global.get $WNDPROC_DIALOG)))

  (func (export "test_defdlg_custom_tail")
    (param $hwnd i32) (param $proc i32) (param $msg i32) (result i32)
    (global.set $image_base (i32.const 0x00400000))
    (call $wnd_table_set (local.get $hwnd) (i32.const 0x006A9070))
    (drop (call $dialog_proc_set (local.get $hwnd) (local.get $proc)))
    (global.set $esp (i32.const 0x00520000))
    (global.set $eip (i32.const 0x00408888))
    (call $gs32 (i32.const 0x00520000) (i32.const 0x006A91A2))
    (call $gs32 (i32.const 0x00520004) (local.get $hwnd))
    (call $gs32 (i32.const 0x00520008) (local.get $msg))
    (call $gs32 (i32.const 0x0052000C) (i32.const 0xAABBCCDD))
    (call $gs32 (i32.const 0x00520010) (i32.const 0x12345678))
    (call $handle_DefDlgProcA
      (local.get $hwnd) (local.get $msg) (i32.const 0xAABBCCDD)
      (i32.const 0x12345678) (i32.const 0) (i32.const 0))
    (global.get $eip))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const hwnd = 0x10020;
  const proc = 0x006ED449;

  assert.strictEqual(wat.test_dispatch_dialog_custom(hwnd, proc, 0x0BD1) >>> 0, proc,
    'DispatchMessage enters the stored DLGPROC without a recursive run');
  assert.strictEqual(wat.get_esp() >>> 0, 0x004FFFF4,
    'the live DLGPROC frame replaces the completed DispatchMessage frame');
  assert.strictEqual(wat.guest_read32(0x004FFFF4) >>> 0, 0x00401234,
    'the DLGPROC returns directly to the original DispatchMessage caller');
  assert.strictEqual(wat.guest_read32(0x004FFFF8) >>> 0, hwnd,
    'the native dialog frame carries its HWND');
  assert.strictEqual(wat.guest_read32(0x004FFFFC) >>> 0, 0x0BD1,
    'the native dialog frame carries the application-defined message');
  assert.strictEqual(wat.guest_read32(0x00500000) >>> 0, 0x11223344,
    'the native dialog frame carries wParam');
  assert.strictEqual(wat.guest_read32(0x00500004) >>> 0, 0x55667788,
    'the native dialog frame carries lParam');
  assert.strictEqual(wat.test_dialog_marker_installed(hwnd), 1,
    'tail dispatch keeps USER32\'s dialog marker installed');

  const stormHwnd = 0x10024;
  assert.strictEqual(wat.test_defdlg_custom_tail(stormHwnd, proc, 0x0BD2) >>> 0, proc,
    'DefDlgProc tail-dispatches a custom message from a native dialog wrapper');
  assert.strictEqual(wat.get_esp() >>> 0, 0x00520000,
    'DefDlgProc reuses its live four-argument stdcall frame');
  assert.strictEqual(wat.guest_read32(0x00520000) >>> 0, 0x006A91A2,
    'the DLGPROC returns to the native wrapper that called DefDlgProc');
  assert.strictEqual(wat.guest_read32(0x00520004) >>> 0, stormHwnd,
    'the reused frame retains the dialog HWND');
  assert.strictEqual(wat.guest_read32(0x00520008) >>> 0, 0x0BD2,
    'the reused frame retains the application-defined message');
  assert.strictEqual(wat.guest_read32(0x0052000C) >>> 0, 0xAABBCCDD,
    'the reused frame retains wParam');
  assert.strictEqual(wat.guest_read32(0x00520010) >>> 0, 0x12345678,
    'the reused frame retains lParam');

  console.log('PASS  custom dialog dispatch preserves the native modal stack');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
