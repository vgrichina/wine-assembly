#!/usr/bin/env node
'use strict';

// WH_KEYBOARD is not a window procedure: USER calls the installed thread hook
// while GetMessage/PeekMessage retrieves a hardware key, before returning the
// MSG to the application. Jazz Jackrabbit 2 keeps its entire private keyboard
// snapshot in this hook, so returning a plausible HHOOK without calling it
// makes every game key permanently up.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const VK_ESCAPE = 0x1b;
const WM_KEYDOWN = 0x0100;
const KEY_LPARAM = 0x00010001; // repeat=1, Escape scan code=1

const extraWat = String.raw`
  (func (export "test_install_keyboard_hook") (param $proc i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_SetWindowsHookExA
      (i32.const 2) (local.get $proc) (i32.const 0) (i32.const 1)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $keyboard_hook_proc))

  (func (export "test_begin_keyboard_peek")
      (param $msg_ptr i32) (param $remove i32) (result i32)
    ;; A zero saved return lets the continuation stop the interpreter cleanly
    ;; after proving that it restored PeekMessage's caller and BOOL result.
    (global.set $esp (i32.sub (global.get $esp) (i32.const 64)))
    (call $gs32 (global.get $esp) (i32.const 0))
    (call $handle_PeekMessageA
      (local.get $msg_ptr) (i32.const 0) (i32.const 0) (i32.const 0)
      (local.get $remove) (i32.const 0))
    (global.get $eip))

  (func (export "test_keyboard_hook_thunk") (result i32)
    (global.get $font_enum_ret_thunk))
`;

function u32(value) {
  return [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);
}

(async () => {
  let pending = true;
  const harness = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      check_input: () => {
        if (!pending) return 0;
        pending = false;
        return ((VK_ESCAPE << 16) | WM_KEYDOWN) >>> 0;
      },
      check_input_hwnd: () => 0,
      check_input_lparam: () => KEY_LPARAM,
    },
  });
  const { exports: e, memory } = harness;

  // Loading a PE initializes the shared CACA0011 continuation thunk and gives
  // the injected x86 hook a normal guest-code mapping.
  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE initializes callback support');
  e.init_dx_com_thunks();

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const observed = e.guest_alloc(12) >>> 0;
  const hook = e.guest_alloc(64) >>> 0;
  const msg = e.guest_alloc(28) >>> 0;

  // KeyboardProc: save nCode/wParam/lParam, deliberately return 0x7f, ret 12.
  // The non-BOOL value proves the continuation restores PeekMessage's TRUE
  // result instead of leaking the hook callback's EAX back to the caller.
  bytes.set(Uint8Array.from([
    0x8b, 0x44, 0x24, 0x04,             // mov eax,[esp+4]  (nCode)
    0xa3, ...u32(observed),              // mov [observed],eax
    0x8b, 0x44, 0x24, 0x08,             // mov eax,[esp+8]  (wParam)
    0xa3, ...u32(observed + 4),
    0x8b, 0x44, 0x24, 0x0c,             // mov eax,[esp+12] (lParam)
    0xa3, ...u32(observed + 8),
    0xb8, 0x7f, 0x00, 0x00, 0x00,
    0xc2, 0x0c, 0x00,
  ]), toWasm(hook));

  assert.strictEqual(e.test_install_keyboard_hook(hook) >>> 0, hook,
    'SetWindowsHookExA(WH_KEYBOARD) retains the guest KeyboardProc');
  assert.notStrictEqual(e.test_keyboard_hook_thunk() >>> 0, 0,
    'generic callback continuation is initialized');
  assert.strictEqual(e.test_begin_keyboard_peek(msg, 1) >>> 0, hook,
    'PM_REMOVE enters KeyboardProc before PeekMessage returns');
  assert.strictEqual(e.guest_read32(e.get_esp()) >>> 0,
    e.test_keyboard_hook_thunk() >>> 0,
    'KeyboardProc stack returns through the generic callback thunk');

  for (let i = 0; i < 20 && e.get_eip(); i++) e.run(5000);
  assert.strictEqual(e.get_eip() >>> 0, 0,
    'KeyboardProc returns through the USER continuation to its caller');
  assert.strictEqual(e.get_eax() >>> 0, 1,
    'PeekMessage returns TRUE rather than the hook callback result');
  assert.deepStrictEqual([
    view.getUint32(toWasm(observed), true),
    view.getUint32(toWasm(observed + 4), true),
    view.getUint32(toWasm(observed + 8), true),
  ], [0, VK_ESCAPE, KEY_LPARAM],
  'KeyboardProc receives HC_ACTION, VK_ESCAPE, and the original key lParam');
  assert.strictEqual(view.getUint32(toWasm(msg + 4), true), WM_KEYDOWN,
    'PeekMessage still returns WM_KEYDOWN in MSG');
  assert.strictEqual(view.getUint32(toWasm(msg + 8), true), VK_ESCAPE,
    'PeekMessage still returns VK_ESCAPE in MSG.wParam');
  assert.strictEqual(view.getUint32(toWasm(msg + 12), true), KEY_LPARAM,
    'PeekMessage preserves the hardware key flags in MSG.lParam');

  console.log('PASS  WH_KEYBOARD sees queued keys before PeekMessage returns');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
