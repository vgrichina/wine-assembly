#!/usr/bin/env node
'use strict';

// SendMessageTimeoutA is what a plug-in uses when it is calling into the host
// application from its own thread and does not want to hang on a window that
// is busy. Winamp's AVS asks for the playing state (WM_USER/IPC 201) and the
// track title (WM_GETTEXT) that way from its render thread.
//
// Our send never blocks -- $wnd_send_message runs the target wndproc to
// completion in the caller's instance -- so the timeout has nothing to expire
// and the only thing that has to be right is the part the caller reads: the
// LRESULT arrives through lpdwResult, not in EAX, and EAX carries success.
// A handle no window owns is the documented failure and must not touch the
// caller's buffer.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const apiTable = require('../src/api_table.json');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_create_dialog") (param $dlgproc i32) (result i32)
    (local $dlg i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_DIALOG))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x90000000)))
    (drop (call $dialog_proc_set (local.get $dlg) (local.get $dlgproc)))
    (local.get $dlg))

  ;; Build the stdcall frame $handle_SendMessageTimeoutA reads -- it takes
  ;; flags/timeout/lpdwResult off the guest stack past the five it is handed --
  ;; call it, then hand back EAX with ESP where we found it.
  (func (export "test_send_message_timeout")
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32)
    (param $timeout i32) (param $result_ptr i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 32)))
    (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $timeout))
    (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (local.get $result_ptr))
    (call $handle_SendMessageTimeoutA
      (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)
      (i32.const 1) (i32.const 0)) ;; SMTO_BLOCK, no name pointer
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_send_message_timeout_w")
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32)
    (param $timeout i32) (param $result_ptr i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 32)))
    (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $timeout))
    (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (local.get $result_ptr))
    (call $handle_SendMessageTimeoutW
      (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)
      (i32.const 1) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

function u32(value) {
  return [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);
}

(async () => {
  assert.strictEqual(apiTable.find(entry => entry.name === 'SendMessageTimeoutW').nargs, 7,
    'SendMessageTimeoutW is available to dynamic import callers');
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
  const result = e.guest_alloc(4) >>> 0;
  const proc = e.guest_alloc(64) >>> 0;

  // DLGPROC(hwnd,msg,wParam,lParam): count WM_USER (0x400), return TRUE.
  bytes.set(Uint8Array.from([
    0x8b, 0x44, 0x24, 0x08,             // mov eax,[esp+8]  ; msg
    0x3d, 0x00, 0x04, 0x00, 0x00,       // cmp eax,0x400
    0x75, 0x06,                         // jne +6
    0xff, 0x05, ...u32(seen),           // inc dword [seen]
    0xb8, 0x01, 0x00, 0x00, 0x00,       // mov eax,1
    0xc2, 0x10, 0x00,                   // ret 0x10
  ]), toWasm(proc));

  const dialog = e.test_create_dialog(proc) >>> 0;
  assert(dialog, 'dialog window was created');

  // The value a plain synchronous send produces is the value the timeout form
  // has to deliver through its buffer.
  const direct = e.send_message(dialog, 0x400, 0, 201) | 0;
  const seenAfterDirect = view.getUint32(toWasm(seen), true);
  assert.strictEqual(seenAfterDirect, 1,
    'the dialog procedure ran for the plain send');

  view.setUint32(toWasm(result), 0xdeadbeef, true);
  const ok = e.test_send_message_timeout(dialog, 0x400, 0, 201, 1000, result) | 0;
  assert.strictEqual(ok, 1,
    'SendMessageTimeoutA reports success for a window that exists');
  assert.strictEqual(view.getUint32(toWasm(seen), true), 2,
    'SendMessageTimeoutA runs the target window procedure');
  assert.strictEqual(view.getUint32(toWasm(result), true) | 0, direct,
    'the LRESULT arrives through lpdwResult, not in EAX');

  // A handle the HWND allocator never issued: fail, and leave the buffer be.
  view.setUint32(toWasm(result), 0xdeadbeef, true);
  const bogus = e.test_send_message_timeout(0xe0, 0x400, 0, 201, 1000, result) | 0;
  assert.strictEqual(bogus, 0,
    'a message to a handle no window owns should fail');
  assert.strictEqual(view.getUint32(toWasm(result), true) >>> 0, 0xdeadbeef,
    'a failed SendMessageTimeoutA must not write the result buffer');
  assert.strictEqual(view.getUint32(toWasm(seen), true), 2,
    'a failed SendMessageTimeoutA runs no window procedure');

  // lpdwResult is optional: the caller may only want the send to happen.
  const noBuffer = e.test_send_message_timeout(dialog, 0x400, 0, 201, 1000, 0) | 0;
  assert.strictEqual(noBuffer, 1, 'a NULL lpdwResult is still a successful send');
  assert.strictEqual(view.getUint32(toWasm(seen), true), 3,
    'a NULL lpdwResult still delivers the message');

  view.setUint32(toWasm(result), 0xdeadbeef, true);
  assert.strictEqual(e.test_send_message_timeout_w(dialog, 0x400, 0, 201, 1000, result), 1,
    'SendMessageTimeoutW reports success for a window that exists');
  assert.strictEqual(view.getUint32(toWasm(result), true) | 0, direct,
    'SendMessageTimeoutW writes the delivered LRESULT');
  assert.strictEqual(view.getUint32(toWasm(seen), true), 4,
    'SendMessageTimeoutW runs the target window procedure');

  console.log('PASS  SendMessageTimeoutA/W deliver their LRESULT through lpdwResult');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
