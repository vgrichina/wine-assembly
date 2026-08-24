#!/usr/bin/env node

'use strict';

// A superclass is still its own class, and GetClassName must say so.
//
// Storm (Diablo's UI library) registers "SDlgStatic" on top of USER's Static
// and then decides which piece of artwork each dialog child gets by walking
// its art registry and strcmp'ing GetClassNameA's answer against that exact
// string (storm.dll 0x15005112). While GetClassNameA collapsed every WAT-owned
// control to the built-in name -- "Static" -- the lookup missed for every
// child of Diablo's main menu, so the flaming logo had no bitmap to paint.
//
//   node test/test-getclassname-superclass.js

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_register_class") (param $wc i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_RegisterClassA
      (local.get $wc) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_create_control_class") (param $class i32) (result i32)
    (call $ctrl_create_child
      (i32.const 0) (local.get $class) (i32.const 77)
      (i32.const 0) (i32.const 0) (i32.const 20) (i32.const 10)
      (i32.const 0) (i32.const 0)))

  (func (export "test_bind_class") (param $hwnd i32) (param $name i32)
    (call $wnd_set_class_slot_from_name (local.get $hwnd) (local.get $name)))

  (func (export "test_call_GetClassNameA")
    (param $hwnd i32) (param $buf i32) (param $max i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetClassNameA
      (local.get $hwnd) (local.get $buf) (local.get $max)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_GetClassNameW")
    (param $hwnd i32) (param $buf i32) (param $max i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetClassNameW
      (local.get $hwnd) (local.get $buf) (local.get $max)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat });
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const base = e.get_guest_base() >>> 0;
  const buf = e.guest_alloc(64) >>> 0;

  const readAnsi = () => {
    let value = '';
    for (let p = base + buf; bytes[p]; p++) value += String.fromCharCode(bytes[p]);
    return value;
  };
  const readWide = () => {
    let value = '';
    for (let p = base + buf; view.getUint16(p, true); p += 2) {
      value += String.fromCharCode(view.getUint16(p, true));
    }
    return value;
  };

  const guestString = (text) => {
    const ptr = e.guest_alloc(text.length + 1) >>> 0;
    for (let i = 0; i < text.length; i++) bytes[base + ptr + i] = text.charCodeAt(i);
    bytes[base + ptr + text.length] = 0;
    return ptr;
  };

  // WNDCLASSA: style(+0) lpfnWndProc(+4) cbClsExtra(+8) cbWndExtra(+12)
  //   hInstance(+16) hIcon(+20) hCursor(+24) hbrBackground(+28)
  //   lpszMenuName(+32) lpszClassName(+36)
  const namePtr = guestString('SDlgStatic');
  const wc = e.guest_alloc(40) >>> 0;
  for (let i = 0; i < 40; i += 4) view.setUint32(base + wc + i, 0, true);
  view.setUint32(base + wc + 4, 0x00401000, true);   // some app wndproc
  view.setUint32(base + wc + 36, namePtr, true);
  assert.ok(e.test_register_class(wc) >>> 0, 'RegisterClassA returns an atom');

  const check = (label, ok) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    assert(ok, label);
  };

  // A Static-backed control whose window was created from the superclass.
  const skinned = e.test_create_control_class(3) >>> 0;
  e.test_bind_class(skinned, namePtr);

  bytes.fill(0xcc, base + buf, base + buf + 64);
  const len = e.test_call_GetClassNameA(skinned, buf, 32) >>> 0;
  check(`GetClassNameA returns the registered name (${JSON.stringify(readAnsi())}, len ${len})`,
    readAnsi() === 'SDlgStatic' && len === 10);

  bytes.fill(0xcc, base + buf, base + buf + 64);
  const wlen = e.test_call_GetClassNameW(skinned, buf, 32) >>> 0;
  check(`GetClassNameW agrees (${JSON.stringify(readWide())}, len ${wlen})`,
    readWide() === 'SDlgStatic' && wlen === 10);

  // nMaxCount still bounds the copy, NUL included.
  bytes.fill(0xcc, base + buf, base + buf + 64);
  const short = e.test_call_GetClassNameA(skinned, buf, 5) >>> 0;
  check(`a short buffer is truncated with room for the NUL (${JSON.stringify(readAnsi())})`,
    readAnsi() === 'SDlg' && short === 4);

  // A control that was never bound to a registered class keeps answering with
  // the built-in name -- the overwhelmingly common case, and what every app
  // that inspects a plain BUTTON expects.
  const plain = e.test_create_control_class(1) >>> 0;
  bytes.fill(0xcc, base + buf, base + buf + 64);
  e.test_call_GetClassNameA(plain, buf, 32);
  check(`an unregistered control still reports its built-in name (${JSON.stringify(readAnsi())})`,
    readAnsi() === 'Button');

  console.log('PASS  GetClassName reports the name a superclassed control was registered under');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
