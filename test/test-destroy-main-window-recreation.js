#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');

const extraWat = String.raw`
  (func (export "test_seed_main_window") (param $hwnd i32)
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_BUILTIN))
    (global.set $main_hwnd (local.get $hwnd)))
  (func (export "test_retire_main_window") (param $hwnd i32) (result i32)
    (call $destroy_main_window_lifecycle (local.get $hwnd))
    (global.get $main_hwnd))

  (func (export "test_seed_focused_destroy")
    (param $root i32) (param $child i32) (param $main i32) (param $main_proc i32)
    (call $wnd_table_set (local.get $root) (global.get $WNDPROC_CTRL_NATIVE))
    (call $wnd_table_set (local.get $child) (global.get $WNDPROC_CTRL_NATIVE))
    (call $wnd_set_parent (local.get $child) (local.get $root))
    (call $wnd_table_set (local.get $main) (local.get $main_proc))
    (global.set $main_hwnd (local.get $main))
    (global.set $focus_hwnd (local.get $child)))

  (func (export "test_begin_DestroyWindow") (param $hwnd i32)
    (call $handle_DestroyWindow
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0)))

  (func (export "test_get_focus_return_thunk") (result i32)
    (global.get $setfocus_ret_thunk))

  (func (export "test_complete_focus_callback")
    ;; Model an x86 zero LRESULT plus ret 16, then enter the real continuation.
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    (call $win32_dispatch
      (i32.div_u
        (i32.sub (global.get $setfocus_ret_thunk) (global.get $thunk_guest_base))
        (i32.const 8))))
`;

(async () => {
  const { exports: wat, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  wat.test_seed_main_window(0x10001);
  assert.strictEqual(wat.get_main_hwnd() >>> 0, 0x10001);
  assert.strictEqual(wat.test_retire_main_window(0x10001) >>> 0, 0,
    'destroying the only top-level clears main_hwnd for its replacement');

  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, wat.get_staging());
  assert(wat.load_pe(fixture.length), 'fixture PE initializes continuation thunks');

  const imageBase = wat.get_image_base() >>> 0;
  const guestBase = wat.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const focusProc = 0x00402000;
  const stack = wat.guest_alloc(64) >>> 0;
  assert.notStrictEqual(wat.test_get_focus_return_thunk() >>> 0, 0,
    'PE loader initialized the focus callback continuation');
  const view = new DataView(memory.buffer);
  view.setUint32(toWasm(stack), 0, true);          // stop after API return
  view.setUint32(toWasm(stack + 4), 0x10010, true);

  wat.test_seed_focused_destroy(0x10010, 0x10011, 0x10012, focusProc);
  wat.set_esp(stack);
  wat.set_ebx(0x11223344);
  wat.set_esi(0x22334455);
  wat.set_edi(0x33445566);
  wat.set_ebp(0x44556677);
  wat.test_begin_DestroyWindow(0x10010);
  assert.strictEqual(wat.get_eip() >>> 0, focusProc,
    'DestroyWindow transfers focus synchronously after removing the focused tree');
  wat.test_complete_focus_callback();
  assert.strictEqual(wat.get_eip() >>> 0, 0,
    'focus callback returns through the saved API continuation');
  assert.strictEqual(wat.get_eax() >>> 0, 1,
    'focus wndproc LRESULT does not replace DestroyWindow TRUE');
  assert.strictEqual(wat.get_esp() >>> 0, (stack + 8) >>> 0,
    'DestroyWindow continuation consumes its one-argument stdcall frame');
  assert.deepStrictEqual([
    wat.get_ebx() >>> 0, wat.get_esi() >>> 0,
    wat.get_edi() >>> 0, wat.get_ebp() >>> 0,
  ], [0x11223344, 0x22334455, 0x33445566, 0x44556677],
  'focus callback preserves the API caller nonvolatile registers');

  console.log('PASS DestroyWindow main lifecycle and focus-return continuation');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
