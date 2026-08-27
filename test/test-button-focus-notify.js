#!/usr/bin/env node
'use strict';

// Standard BUTTON controls send BN_SETFOCUS/BN_KILLFOCUS to their parent
// when BS_NOTIFY is set. Diablo's class picker depends on these notifications:
// focusing Warrior selects it, while BN_CLICKED only confirms the selection.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_create_notify_button")
    (param $dlgproc i32) (param $style i32) (param $id i32) (result i32)
    (local $dlg i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_DIALOG))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x90000000)))
    (drop (call $dialog_proc_set (local.get $dlg) (local.get $dlgproc)))
    (call $ctrl_create_child
      (local.get $dlg) (i32.const 1) (local.get $id)
      (i32.const 0) (i32.const 0) (i32.const 100) (i32.const 24)
      (local.get $style) (i32.const 0)))

  (func (export "test_button_state") (param $hwnd i32) (result i32)
    (call $wnd_get_state_ptr (local.get $hwnd)))

  (func (export "test_button_message")
    (param $hwnd i32) (param $msg i32) (result i32)
    (call $button_wndproc
      (local.get $hwnd) (local.get $msg) (i32.const 0) (i32.const 0)))
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
  const result = e.guest_alloc(12) >>> 0;
  const proc = e.guest_alloc(64) >>> 0;

  // DLGPROC(hwnd,msg,wParam,lParam): capture the three message values, return TRUE.
  const code = Uint8Array.from([
    0x81, 0x7c, 0x24, 0x08, 0x11, 0x01, 0x00, 0x00,
    0x75, 0x1b,
    0x8b, 0x44, 0x24, 0x08, 0xa3, ...u32(result),
    0x8b, 0x44, 0x24, 0x0c, 0xa3, ...u32(result + 4),
    0x8b, 0x44, 0x24, 0x10, 0xa3, ...u32(result + 8),
    0xb8, 0x01, 0x00, 0x00, 0x00,
    0xc2, 0x10, 0x00,
  ]);
  bytes.set(code, toWasm(proc));

  const readCaptured = () => [
    view.getUint32(toWasm(result), true),
    view.getUint32(toWasm(result + 4), true),
    view.getUint32(toWasm(result + 8), true),
  ];
  const clearCaptured = () => {
    view.setUint32(toWasm(result), 0, true);
    view.setUint32(toWasm(result + 4), 0, true);
    view.setUint32(toWasm(result + 8), 0, true);
  };

  const id = 1062;
  const notifyButton = e.test_create_notify_button(proc, 0x50014000, id) >>> 0;
  const notifyParent = e.wnd_get_parent(notifyButton) >>> 0;
  assert(notifyParent, 'button has a parent dialog');
  assert.strictEqual(e.dialog_get_proc_export(notifyParent) >>> 0, proc,
    'parent retains the capture DLGPROC');
  assert((e.wnd_get_style_export(notifyButton) >>> 0) & 0x4000,
    'button retains BS_NOTIFY');
  assert(e.test_button_state(notifyButton) >>> 0, 'button has native state');
  assert.strictEqual(e.wnd_get_proc_export(notifyButton) >>> 0, 0xffff0002,
    'button uses the native control procedure');
  e.send_message(notifyParent, 0x0111, 0x1234, notifyButton);
  assert.deepStrictEqual(readCaptured(), [0x0111, 0x1234, notifyButton],
    'capture DLGPROC records synchronous parent messages');
  clearCaptured();
  e.test_button_message(notifyButton, 0x0007);
  assert.strictEqual(e.get_focus_hwnd() >>> 0, notifyButton,
    'native button processed WM_SETFOCUS');
  assert.deepStrictEqual(readCaptured(), [0x0111, (6 << 16) | id, notifyButton],
    'BS_NOTIFY button sends BN_SETFOCUS through WM_COMMAND');

  clearCaptured();
  e.test_button_message(notifyButton, 0x0008);
  assert.deepStrictEqual(readCaptured(), [0x0111, (7 << 16) | id, notifyButton],
    'BS_NOTIFY button sends BN_KILLFOCUS through WM_COMMAND');

  // Real-Threads browser input reaches the live Worker as a queued mouse
  // message; renderer-side focus calls run on an idle ownership instance.
  // BUTTON must therefore perform USER's focus transfer from its own live
  // wndproc before it handles the press.
  clearCaptured();
  e.test_button_message(notifyButton, 0x0201);
  assert.strictEqual(e.get_focus_hwnd() >>> 0, notifyButton,
    'button-down transfers focus on the instance dispatching the message');
  assert.deepStrictEqual(readCaptured(), [0x0111, (6 << 16) | id, notifyButton],
    'button-down emits BS_NOTIFY BN_SETFOCUS before the click notification');

  clearCaptured();
  e.test_button_message(notifyButton, 0x0203);
  assert.deepStrictEqual(readCaptured(), [0x0111, (5 << 16) | id, notifyButton],
    'BS_NOTIFY button sends BN_DOUBLECLICKED through WM_COMMAND');

  clearCaptured();
  const plainButton = e.test_create_notify_button(proc, 0x50010000, id + 1) >>> 0;
  e.test_button_message(plainButton, 0x0007);
  assert.deepStrictEqual(readCaptured(), [0, 0, 0],
    'button without BS_NOTIFY does not send focus notifications');

  e.test_button_message(plainButton, 0x0203);
  assert.deepStrictEqual(readCaptured(), [0, 0, 0],
    'plain push button without BS_NOTIFY does not send BN_DOUBLECLICKED');

  const ownerDrawButton = e.test_create_notify_button(proc, 0x5001000b, id + 2) >>> 0;
  e.test_button_message(ownerDrawButton, 0x0203);
  assert.deepStrictEqual(readCaptured(), [0x0111, (5 << 16) | (id + 2), ownerDrawButton],
    'owner-draw button sends BN_DOUBLECLICKED without BS_NOTIFY');

  console.log('PASS  BUTTON BS_NOTIFY focus notifications');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
