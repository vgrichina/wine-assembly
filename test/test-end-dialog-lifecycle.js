#!/usr/bin/env node
'use strict';

// EndDialog destroys the dialog with the same window lifecycle as
// DestroyWindow. Storm's SDlgEndDialog uses it for modeless nested dialogs and
// depends on WM_DESTROY/WM_NCDESTROY before the owner continues.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_create_modeless_dialog")
    (param $dlgproc i32) (result i64)
    (local $dlg i32) (local $child i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_DIALOG))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x90000000)))
    (drop (call $dialog_proc_set (local.get $dlg) (local.get $dlgproc)))
    (local.set $child (call $ctrl_create_child
      (local.get $dlg) (i32.const 1) (i32.const 1062)
      (i32.const 0) (i32.const 0) (i32.const 100) (i32.const 24)
      (i32.const 0x5001400b) (i32.const 0)))
    (i64.or (i64.extend_i32_u (local.get $dlg))
      (i64.shl (i64.extend_i32_u (local.get $child)) (i64.const 32))))

  (func (export "test_call_EndDialog") (param $hwnd i32) (param $result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_EndDialog
      (local.get $hwnd) (local.get $result)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp)))

  (func (export "test_set_modal_dialog") (param $hwnd i32)
    (global.set $dlg_pump_hwnd (local.get $hwnd)))

  (func (export "test_yield_flag") (result i32)
    (global.get $yield_flag))

  (func (export "test_window_exists") (param $hwnd i32) (result i32)
    (i32.ge_s (call $wnd_table_find (local.get $hwnd)) (i32.const 0)))
`;

function u32(value) {
  return [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);
}

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat });
  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE initializes x86 callback support');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const seen = e.guest_alloc(4) >>> 0;
  const proc = e.guest_alloc(64) >>> 0;

  // DLGPROC(hwnd,msg,wParam,lParam): OR bit 0 for WM_DESTROY and bit 1 for
  // WM_NCDESTROY, then return TRUE.
  bytes.set(Uint8Array.from([
    0x8b, 0x44, 0x24, 0x08,
    0x83, 0xf8, 0x02,
    0x75, 0x07,
    0x83, 0x0d, ...u32(seen), 0x01,
    0x3d, 0x82, 0x00, 0x00, 0x00,
    0x75, 0x07,
    0x83, 0x0d, ...u32(seen), 0x02,
    0xb8, 0x01, 0x00, 0x00, 0x00,
    0xc2, 0x10, 0x00,
  ]), toWasm(proc));

  const packed = BigInt.asUintN(64, e.test_create_modeless_dialog(proc));
  const dialog = Number(packed & 0xffffffffn) >>> 0;
  const child = Number(packed >> 32n) >>> 0;
  assert(dialog && child, 'modeless dialog and focused child were created');

  e.send_message(child, 0x0007, 0, 0); // WM_SETFOCUS
  assert.strictEqual(e.get_focus_hwnd() >>> 0, child,
    'dialog child owns focus before EndDialog');

  e.test_call_EndDialog(dialog, 1062);
  assert.strictEqual(view.getUint32(toWasm(seen), true), 3,
    'EndDialog delivers WM_DESTROY and WM_NCDESTROY to the dialog procedure');
  assert.strictEqual(e.test_window_exists(child), 0,
    'EndDialog recursively destroys child controls');
  assert.strictEqual(e.test_window_exists(dialog), 0,
    'EndDialog destroys the dialog record');
  assert.strictEqual(e.get_focus_hwnd() >>> 0, 0,
    'EndDialog clears focus held by a destroyed child');
  assert.strictEqual(e.test_yield_flag(), 0,
    'modeless EndDialog does not abandon its synchronous native call stack');

  const modalPacked = BigInt.asUintN(64, e.test_create_modeless_dialog(proc));
  const modalDialog = Number(modalPacked & 0xffffffffn) >>> 0;
  e.test_set_modal_dialog(modalDialog);
  e.test_call_EndDialog(modalDialog, 42);
  assert.strictEqual(e.test_yield_flag(), 1,
    'active Wine Assembly modal EndDialog yields to its dialog pump');

  console.log('PASS  EndDialog preserves recursive window teardown lifecycle');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
