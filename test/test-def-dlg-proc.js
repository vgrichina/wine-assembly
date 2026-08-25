#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_call_DefDlgProcA")
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DefDlgProcA
      (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DefDlgProcW")
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DefDlgProcW
      (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_defdlg_paint_validates")
    (param $hwnd i32) (result i32)
    (local $saved_esp i32) (local $before i32)
    (call $update_invalidate_rect
      (local.get $hwnd) (i32.const 1) (i32.const 2)
      (i32.const 30) (i32.const 40))
    (local.set $before (call $update_get_rect (local.get $hwnd) (i32.const 0)))
    (local.set $saved_esp (global.get $esp))
    (call $handle_DefDlgProcA
      (local.get $hwnd) (i32.const 0x000F) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (i32.or (i32.shl (local.get $before) (i32.const 1))
      (call $update_get_rect (local.get $hwnd) (i32.const 0))))

  (func (export "test_call_SetWindowLongA_dialog_proc")
    (param $hwnd i32) (param $proc i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_SetWindowLongA
      (local.get $hwnd) (i32.const 4) (local.get $proc)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_get_dialog_proc") (param $hwnd i32) (result i32)
    (call $dialog_proc_get (local.get $hwnd)))
`;

(async () => {
  const apiTable = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api_table.json'), 'utf8'));
  for (const name of ['DefDlgProcA', 'DefDlgProcW']) {
    const api = apiTable.find(entry => entry.name === name);
    assert(api, `${name} is present in the runtime API table`);
    assert.strictEqual(api.nargs, 4, `${name} has the Win32 four-argument ABI`);
  }

  const { exports: e } = await bootRenderHarness({ extraWat });
  const hwnd = e.test_create_edit(0, 0, 40, 20, 0x50000000, 0) >>> 0;

  assert.strictEqual(e.test_call_DefDlgProcA(hwnd, 0x0081, 0, 0), 1,
    'DefDlgProcA accepts WM_NCCREATE when no DLGPROC handles it');
  assert.strictEqual(e.test_call_DefDlgProcW(hwnd, 0x0081, 0, 0), 1,
    'DefDlgProcW shares the encoding-neutral WM_NCCREATE default');
  assert.strictEqual(e.test_defdlg_paint_validates(hwnd), 2,
    'unhandled DefDlgProcA WM_PAINT delegates to DefWindowProc and validates');

  assert.strictEqual(e.test_call_SetWindowLongA_dialog_proc(hwnd, 0x006E1720), 0,
    'SetWindowLongA(DWLP_DLGPROC) returns the previous dialog procedure');
  assert.strictEqual(e.test_get_dialog_proc(hwnd) >>> 0, 0x006E1720,
    'SetWindowLongA(DWLP_DLGPROC) attaches the procedure to DefDlgProc state');

  console.log('PASS  DefDlgProcA/W preserve dialog dispatch and default-window semantics');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
