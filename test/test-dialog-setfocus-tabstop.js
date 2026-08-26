#!/usr/bin/env node

// DefDlgProc's WM_SETFOCUS rule: USER moves the caret to the dialog's first
// visible, enabled tab stop when the DLGPROC does not take WM_SETFOCUS for
// itself. Diablo's Enter Name dialog depends on it -- its DLGPROC returns
// FALSE from WM_INITDIALOG and never calls SetFocus, so without this rule the
// edit field never sees a keystroke and the game rejects an empty hero name.

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const WS_CHILD_VISIBLE = 0x50000000;
const WS_TABSTOP = 0x00010000;
const WS_DISABLED = 0x08000000;
const WM_SETFOCUS = 0x0007;

const extraWat = String.raw`
  (func (export "test_setfocus_make_dialog") (result i32)
    (local $dlg i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_CTRL_NATIVE))
    ;; WS_POPUP | WS_VISIBLE -- a top-level window whose children can be
    ;; effectively visible.
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x90000000)))
    (local.get $dlg))

  (func (export "test_setfocus_add_child")
    (param $dlg i32) (param $id i32) (param $style i32) (result i32)
    (call $ctrl_create_child
      (local.get $dlg) (i32.const 2) (local.get $id)
      (i32.const 0) (i32.const 0) (i32.const 40) (i32.const 20)
      (local.get $style) (i32.const 0)))

  (func (export "test_focus_hwnd") (result i32) (global.get $focus_hwnd))

  (func (export "test_set_focus_hwnd") (param $hwnd i32)
    (global.set $focus_hwnd (local.get $hwnd)))

  (func (export "test_call_DefDlgProcA")
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32)
    (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DefDlgProcA
      (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat });

  // A dialog whose first child is not a tab stop: the focus skips it.
  const dlg = e.test_setfocus_make_dialog() >>> 0;
  const plain = e.test_setfocus_add_child(dlg, 100, WS_CHILD_VISIBLE) >>> 0;
  const field = e.test_setfocus_add_child(
    dlg, 101, WS_CHILD_VISIBLE | WS_TABSTOP) >>> 0;

  e.test_set_focus_hwnd(0);
  e.test_call_DefDlgProcA(dlg, WM_SETFOCUS, 0, 0);
  assert.strictEqual(e.test_focus_hwnd() >>> 0, field,
    'DefDlgProc WM_SETFOCUS focuses the first WS_TABSTOP child');
  assert.notStrictEqual(e.test_focus_hwnd() >>> 0, plain,
    'a child without WS_TABSTOP is not a focus candidate');

  // Calling it again is idempotent -- it must not hand the focus onward to a
  // later tab stop the way WM_NEXTDLGCTL would.
  e.test_call_DefDlgProcA(dlg, WM_SETFOCUS, 0, 0);
  assert.strictEqual(e.test_focus_hwnd() >>> 0, field,
    'a repeated WM_SETFOCUS leaves the focus where it is');

  // A disabled tab stop is skipped: USER will not focus a control the user
  // cannot reach with the Tab key either.
  const dlg2 = e.test_setfocus_make_dialog() >>> 0;
  e.test_setfocus_add_child(
    dlg2, 200, WS_CHILD_VISIBLE | WS_TABSTOP | WS_DISABLED);
  const enabled = e.test_setfocus_add_child(
    dlg2, 201, WS_CHILD_VISIBLE | WS_TABSTOP) >>> 0;

  e.test_set_focus_hwnd(0);
  e.test_call_DefDlgProcA(dlg2, WM_SETFOCUS, 0, 0);
  assert.strictEqual(e.test_focus_hwnd() >>> 0, enabled,
    'DefDlgProc WM_SETFOCUS skips a disabled tab stop');

  // No tab stop at all: WM_SETFOCUS falls through to DefWindowProc rather
  // than inventing a focus window.
  const dlg3 = e.test_setfocus_make_dialog() >>> 0;
  e.test_setfocus_add_child(dlg3, 300, WS_CHILD_VISIBLE);

  e.test_set_focus_hwnd(0);
  e.test_call_DefDlgProcA(dlg3, WM_SETFOCUS, 0, 0);
  assert.strictEqual(e.test_focus_hwnd() >>> 0, 0,
    'a dialog with no tab stop leaves the focus untouched');

  console.log('PASS  DefDlgProc WM_SETFOCUS moves the focus to the first tab stop');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
