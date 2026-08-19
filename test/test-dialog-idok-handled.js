#!/usr/bin/env node
'use strict';

// A dialog procedure's handled BOOL is distinct from DWL_MSGRESULT. Modeless
// dialogs own their lifetime regardless of that BOOL; only DialogBoxParamA's
// modal pump supplies the dialog-manager IDOK fallback.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_create_idok_button") (param $dlgproc i32) (result i32)
    (local $dlg i32) (local $slot i32) (local $rec i32) (local $button i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_DIALOG))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x90000000)))
    (local.set $slot (call $wnd_table_find (local.get $dlg)))
    (call $ctrl_geom_set (local.get $slot)
      (i32.const 0) (i32.const 0) (i32.const 160) (i32.const 80))
    (local.set $rec (call $dlg_record_for_hwnd (local.get $dlg)))
    (i32.store (local.get $rec) (i32.const 1))
    (i32.store offset=4 (local.get $rec) (i32.const 0x90000000))
    (i32.store offset=28 (local.get $rec) (i32.const 1))
    (drop (call $dialog_proc_set (local.get $dlg) (local.get $dlgproc)))
    (local.set $button (call $ctrl_create_child
      (local.get $dlg) (i32.const 1) (i32.const 1)
      (i32.const 8) (i32.const 8) (i32.const 72) (i32.const 24)
      (i32.const 0x50010001) (i32.const 0)))
    (local.get $button))

  (func (export "test_window_exists") (param $hwnd i32) (result i32)
    (i32.ge_s (call $wnd_table_find (local.get $hwnd)) (i32.const 0)))

  (func (export "test_set_modal_dialog") (param $hwnd i32)
    (global.set $dlg_pump_hwnd (local.get $hwnd)))
`;

(async () => {
  const harness = await bootRenderHarness({ extraWat });
  const { exports: e, memory } = harness;
  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE initializes x86 continuation thunks');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const writeProc = code => {
    const guest = e.guest_alloc(code.length) >>> 0;
    bytes.set(code, toWasm(guest));
    return guest;
  };
  const click = button => {
    e.send_message(button, 0x0201, 1, 0);
    e.send_message(button, 0x0202, 0, 0);
  };

  // mov eax,1; ret 16 — handled WM_COMMAND with the default zero
  // DWL_MSGRESULT. The dialog procedure intentionally keeps the dialog alive.
  const handledProc = writeProc(Uint8Array.from([
    0xB8, 0x01, 0x00, 0x00, 0x00, 0xC2, 0x10, 0x00,
  ]));
  const handledButton = e.test_create_idok_button(handledProc) >>> 0;
  const handledDialog = e.wnd_get_parent(handledButton) >>> 0;
  click(handledButton);
  assert.strictEqual(e.test_window_exists(handledDialog), 1,
    'handled IDOK must not run the dialog manager default close');

  // xor eax,eax; ret 16 — an unhandled modeless WM_COMMAND still leaves
  // lifetime control with the application.
  const unhandledProc = writeProc(Uint8Array.from([
    0x31, 0xC0, 0xC2, 0x10, 0x00,
  ]));
  const modelessButton = e.test_create_idok_button(unhandledProc) >>> 0;
  const modelessDialog = e.wnd_get_parent(modelessButton) >>> 0;
  click(modelessButton);
  assert.strictEqual(e.test_window_exists(modelessDialog), 1,
    'unhandled modeless IDOK must not destroy a CreateDialogParamA window');

  const modalButton = e.test_create_idok_button(unhandledProc) >>> 0;
  const modalDialog = e.wnd_get_parent(modalButton) >>> 0;
  e.test_set_modal_dialog(modalDialog);
  click(modalButton);
  assert.strictEqual(e.test_window_exists(modalDialog), 0,
    'unhandled modal IDOK receives the DialogBoxParamA fallback close');

  console.log('PASS  dialog IDOK fallback is modal-only');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
