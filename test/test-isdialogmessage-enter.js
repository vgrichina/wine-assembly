#!/usr/bin/env node
'use strict';

// IsDialogMessage is where a dialog's Enter and Escape keys live.
//
// An edit control does not act on VK_RETURN and a plain pushbutton does not
// act on VK_ESCAPE -- USER turns those two keystrokes into WM_COMMAND for the
// dialog itself, which is how any "type a name, press Enter" dialog advances.
// Diablo's name-entry dialog is exactly that: its edit control handles only
// VK_LEFT, its OK button is disabled and ownerdrawn (so it is not a default
// pushbutton either), and the dialog procedure starts the game from
// WM_COMMAND id IDOK. While IsDialogMessageA answered 0 unconditionally the
// keystroke fell through to the control and disappeared.
//
//   node test/test-isdialogmessage-enter.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_make_dialog") (param $dlgproc i32) (result i32)
    (local $dlg i32) (local $slot i32) (local $rec i32)
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
    (local.get $dlg))

  (func (export "test_add_button") (param $dlg i32) (param $id i32) (result i32)
    (call $ctrl_create_child
      (local.get $dlg) (i32.const 1) (local.get $id)
      (i32.const 8) (i32.const 8) (i32.const 72) (i32.const 24)
      (i32.const 0x50010000) (i32.const 0)))

  (func (export "test_is_dialog_message") (param $dlg i32) (param $msg i32) (result i32)
    (call $handle_IsDialogMessageA
      (local.get $dlg) (local.get $msg)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
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
  const view = new DataView(memory.buffer);

  // Four bytes the dialog procedure writes the WM_COMMAND wParam into, so the
  // test reads back exactly what USER decided to send.
  const record = e.guest_alloc(4) >>> 0;
  view.setUint32(toWasm(record), 0, true);

  //   mov eax,[esp+8]        ; uMsg
  //   cmp eax,0x111          ; WM_COMMAND
  //   jne ret1
  //   mov eax,[esp+0xC]      ; wParam
  //   mov [record],eax
  // ret1:
  //   mov eax,1
  //   ret 16
  const proc = Uint8Array.from([
    0x8B, 0x44, 0x24, 0x08,
    0x3D, 0x11, 0x01, 0x00, 0x00,
    0x75, 0x09,
    0x8B, 0x44, 0x24, 0x0C,
    0xA3, record & 0xFF, (record >>> 8) & 0xFF, (record >>> 16) & 0xFF, (record >>> 24) & 0xFF,
    0xB8, 0x01, 0x00, 0x00, 0x00,
    0xC2, 0x10, 0x00,
  ]);
  const dlgproc = e.guest_alloc(proc.length) >>> 0;
  bytes.set(proc, toWasm(dlgproc));

  const dlg = e.test_make_dialog(dlgproc) >>> 0;
  const ok = e.test_add_button(dlg, 1) >>> 0;
  e.test_add_button(dlg, 2);

  const msg = e.guest_alloc(16) >>> 0;
  const post = (hwnd, message, wParam) => {
    const p = toWasm(msg);
    view.setUint32(p, hwnd, true);
    view.setUint32(p + 4, message, true);
    view.setUint32(p + 8, wParam, true);
    view.setUint32(p + 12, 0, true);
    view.setUint32(toWasm(record), 0, true);
    const claimed = e.test_is_dialog_message(dlg, msg) >>> 0;
    return { claimed, command: view.getUint32(toWasm(record), true) >>> 0 };
  };

  const check = (label, ok_) => {
    console.log(`${ok_ ? 'PASS' : 'FAIL'}  ${label}`);
    assert(ok_, label);
  };

  // Enter, pressed on a child of the dialog, becomes IDOK for the dialog.
  let r = post(ok, 0x0100, 0x0D);
  check(`Enter is claimed by the dialog manager (${r.claimed})`, r.claimed === 1);
  check(`Enter arrives as WM_COMMAND IDOK (${r.command})`, r.command === 1);

  // Escape becomes IDCANCEL.
  r = post(ok, 0x0100, 0x1B);
  check(`Escape is claimed (${r.claimed})`, r.claimed === 1);
  check(`Escape arrives as WM_COMMAND IDCANCEL (${r.command})`, r.command === 2);

  // Everything else is still the application's to dispatch: answering 0 keeps
  // the caller's own TranslateMessage/DispatchMessage in charge.
  r = post(ok, 0x0100, 0x09);
  check('Tab is left to the caller', r.claimed === 0 && r.command === 0);
  r = post(ok, 0x0102, 0x0D);
  check('WM_CHAR is left to the caller', r.claimed === 0 && r.command === 0);

  // A message for a window outside this dialog is never a dialog message.
  r = post(0x4321, 0x0100, 0x0D);
  check('a foreign hwnd is left alone', r.claimed === 0 && r.command === 0);

  console.log('PASS  IsDialogMessage turns Enter into IDOK and Escape into IDCANCEL');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
