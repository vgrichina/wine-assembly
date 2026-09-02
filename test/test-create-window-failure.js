#!/usr/bin/env node
'use strict';

// Win98 treats window creation as a transaction. A FALSE WM_NCCREATE or -1
// WM_CREATE result returns NULL, sends WM_NCDESTROY, and removes the nascent
// HWND without sending the later creation messages. CreateWindowExW must also
// mark the HWND that USER actually allocated before either callback runs.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');

const extraWat = String.raw`
  (func (export "test_register_class") (param $wc i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_RegisterClassA
      (local.get $wc) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_begin_create")
      (param $wide i32) (param $class i32) (param $title i32)
      (param $style i32) (param $parent i32) (param $stack i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $gs32 (global.get $esp) (i32.const 0x00ABCDEF))
    (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (i32.const 10))
    (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (i32.const 160))
    (call $gs32 (i32.add (global.get $esp) (i32.const 32)) (i32.const 100))
    (call $gs32 (i32.add (global.get $esp) (i32.const 36)) (local.get $parent))
    (call $gs32 (i32.add (global.get $esp) (i32.const 40)) (i32.const 101))
    (call $gs32 (i32.add (global.get $esp) (i32.const 44)) (global.get $image_base))
    (call $gs32 (i32.add (global.get $esp) (i32.const 48)) (i32.const 0))
    (if (local.get $wide)
      (then
        (call $handle_CreateWindowExW
          (i32.const 0) (local.get $class) (local.get $title)
          (local.get $style) (i32.const 10) (i32.const 0)))
      (else
        (call $handle_CreateWindowExA
          (i32.const 0) (local.get $class) (local.get $title)
          (local.get $style) (i32.const 10) (i32.const 0))))
    (global.get $eax))

  (func (export "test_callback_msg") (result i32)
    (call $gl32 (i32.add (global.get $esp) (i32.const 8))))

  (func (export "test_callback_hwnd") (result i32)
    (call $gl32 (i32.add (global.get $esp) (i32.const 4))))

  (func (export "test_return_callback") (param $result i32)
    (local $thunk i32)
    ;; Model ret 16: pop the callback return address and four WndProc args,
    ;; then enter the same CACA continuation the x86 interpreter would.
    (local.set $thunk (call $gl32 (global.get $esp)))
    (global.set $eax (local.get $result))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    (call $win32_dispatch
      (i32.div_u
        (i32.sub (local.get $thunk) (global.get $thunk_guest_base))
        (i32.const 8))))

  (func (export "test_window_exists") (param $hwnd i32) (result i32)
    (i32.ne (call $wnd_table_get (local.get $hwnd)) (i32.const 0)))

  (func (export "test_window_unicode") (param $hwnd i32) (result i32)
    (call $wnd_unicode_get (local.get $hwnd)))

  (func (export "test_sysclass_nccreate")
      (param $hwnd i32) (param $stack i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $gs32 (global.get $esp) (i32.const 0))
    (call $handle_CallWindowProcA
      (i32.or (global.get $WNDPROC_SYSCLASS) (i32.const 1)) ;; BUTTON
      (local.get $hwnd) (i32.const 0x0081) (i32.const 0) (i32.const 0)
      (i32.const 0))
    (global.get $eax))

  (func (export "test_native_nccreate")
      (param $hwnd i32) (param $stack i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $gs32 (global.get $esp) (i32.const 0))
    (call $handle_CallWindowProcA
      (global.get $WNDPROC_CTRL_NATIVE)
      (local.get $hwnd) (i32.const 0x0081) (i32.const 0) (i32.const 0)
      (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const destroyed = [];
  const { exports: e, memory } = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      destroy_window: hwnd => destroyed.push(hwnd >>> 0),
    },
  });

  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE initializes continuation thunks');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const proc = imageBase + 0x1000;
  const procWasm = guestBase + 0x1000;
  const teardownMsg = e.guest_alloc(4) >>> 0;
  const teardownCount = e.guest_alloc(4) >>> 0;
  const le32 = value => [
    value & 0xff, (value >>> 8) & 0xff,
    (value >>> 16) & 0xff, value >>> 24,
  ];
  // mov eax,[esp+8]; mov [teardownMsg],eax;
  // inc dword ptr [teardownCount]; xor eax,eax; ret 16.
  // Abort cleanup executes this for WM_NCDESTROY; the trace also proves it
  // did not send the ordinary WM_DESTROY first.
  new Uint8Array(memory.buffer).set([
    0x8b, 0x44, 0x24, 0x08,
    0xa3, ...le32(teardownMsg),
    0xff, 0x05, ...le32(teardownCount),
    0x31, 0xc0, 0xc2, 0x10, 0x00,
  ], procWasm);

  const ansi = text => {
    const ptr = e.guest_alloc(text.length + 1) >>> 0;
    for (let i = 0; i < text.length; i++) e.guest_write8(ptr + i, text.charCodeAt(i));
    e.guest_write8(ptr + text.length, 0);
    return ptr;
  };
  const wide = text => {
    const ptr = e.guest_alloc((text.length + 1) * 2) >>> 0;
    for (let i = 0; i < text.length; i++) {
      e.guest_write8(ptr + i * 2, text.charCodeAt(i));
      e.guest_write8(ptr + i * 2 + 1, 0);
    }
    e.guest_write8(ptr + text.length * 2, 0);
    e.guest_write8(ptr + text.length * 2 + 1, 0);
    return ptr;
  };

  const classA = ansi('RejectCreate');
  const classW = wide('RejectCreate');
  const titleA = ansi('ANSI');
  const titleW = wide('Unicode');
  const wc = e.guest_alloc(40) >>> 0;
  const stack = e.guest_alloc(256) >>> 0;
  for (let offset = 0; offset < 40; offset += 4) e.guest_write32(wc + offset, 0);
  e.guest_write32(wc + 4, proc);
  e.guest_write32(wc + 16, imageBase);
  e.guest_write32(wc + 36, classA);
  assert.ok(e.test_register_class(wc) >>> 0, 'custom class registers');

  const rejectNc = e.test_begin_create(1, classW, titleW, 0, 0, stack) >>> 0;
  assert.strictEqual(e.test_callback_msg() >>> 0, 0x0081, 'creation starts with WM_NCCREATE');
  assert.strictEqual(e.test_callback_hwnd() >>> 0, rejectNc);
  assert.strictEqual(e.test_window_unicode(rejectNc) >>> 0, 1,
    'CreateWindowExW marks the allocated HWND before WM_NCCREATE');
  e.test_return_callback(0);
  assert.strictEqual(e.get_eax() >>> 0, 0, 'FALSE WM_NCCREATE returns NULL');
  assert.strictEqual(e.get_eip() >>> 0, 0x00abcdef, 'WM_CREATE is not dispatched after rejection');
  assert.strictEqual(e.test_window_exists(rejectNc) >>> 0, 0, 'rejected HWND is unpublished');
  assert.strictEqual(e.test_window_unicode(rejectNc) >>> 0, 0, 'rejected HWND leaves no Unicode state');
  assert.strictEqual(e.guest_read32(teardownMsg) >>> 0, 0x0082,
    'failed WM_NCCREATE is followed by WM_NCDESTROY');
  assert.strictEqual(e.guest_read32(teardownCount) >>> 0, 1,
    'creation failure does not send ordinary WM_DESTROY');

  const accepted = e.test_begin_create(0, classA, titleA, 0, 0, stack) >>> 0;
  assert.ok(accepted > rejectNc, 'a rejected creation still consumes its HWND value');
  assert.strictEqual(e.test_window_unicode(accepted) >>> 0, 0,
    'the following ANSI window does not inherit Unicode state');
  e.test_return_callback(1);
  assert.strictEqual(e.test_callback_msg() >>> 0, 0x0001, 'successful WM_NCCREATE advances to WM_CREATE');
  e.test_return_callback(0);
  assert.strictEqual(e.get_eax() >>> 0, accepted, 'successful creation returns its HWND');
  assert.strictEqual(e.test_window_exists(accepted) >>> 0, 1);
  assert.strictEqual(e.guest_read32(teardownCount) >>> 0, 1,
    'successful creation does not enter teardown');

  const rejectCreate = e.test_begin_create(1, classW, titleW, 0, 0, stack) >>> 0;
  e.test_return_callback(1);
  assert.strictEqual(e.test_callback_msg() >>> 0, 0x0001);
  e.test_return_callback(-1);
  assert.strictEqual(e.get_eax() >>> 0, 0, 'WM_CREATE -1 returns NULL');
  assert.strictEqual(e.get_eip() >>> 0, 0x00abcdef);
  assert.strictEqual(e.test_window_exists(rejectCreate) >>> 0, 0,
    'WM_CREATE rejection removes the nascent window');
  assert.strictEqual(e.guest_read32(teardownMsg) >>> 0, 0x0082);
  assert.strictEqual(e.guest_read32(teardownCount) >>> 0, 2);
  assert.deepStrictEqual(destroyed, [rejectNc, rejectCreate],
    'each rejected creation removes its host window exactly once');

  const rejectChild = e.test_begin_create(
    1, classW, titleW, 0x40000000, accepted, stack) >>> 0;
  assert.strictEqual(e.test_callback_msg() >>> 0, 0x0081, 'custom child also starts with WM_NCCREATE');
  e.test_return_callback(1);
  assert.strictEqual(e.test_callback_msg() >>> 0, 0x0001, 'custom child advances to WM_CREATE');
  e.test_return_callback(-1);
  assert.strictEqual(e.get_eax() >>> 0, 0, 'child WM_CREATE -1 returns NULL');
  assert.strictEqual(e.test_window_exists(rejectChild) >>> 0, 0,
    'rejected child is unpublished before any WM_SIZE');
  assert.strictEqual(e.guest_read32(teardownCount) >>> 0, 3);
  assert.deepStrictEqual(destroyed, [rejectNc, rejectCreate, rejectChild]);

  const rejectChildNc = e.test_begin_create(
    1, classW, titleW, 0x40000000, accepted, stack) >>> 0;
  e.test_return_callback(0);
  assert.strictEqual(e.get_eax() >>> 0, 0, 'child FALSE WM_NCCREATE returns NULL');
  assert.strictEqual(e.get_eip() >>> 0, 0x00abcdef,
    'child WM_CREATE is not dispatched after WM_NCCREATE rejection');
  assert.strictEqual(e.test_window_exists(rejectChildNc) >>> 0, 0);
  assert.strictEqual(e.guest_read32(teardownCount) >>> 0, 4);
  assert.deepStrictEqual(destroyed,
    [rejectNc, rejectCreate, rejectChild, rejectChildNc]);

  assert.strictEqual(e.test_sysclass_nccreate(accepted, stack) >>> 0, 1,
    'a subclass chained to a USER system class accepts WM_NCCREATE');
  assert.strictEqual(e.test_native_nccreate(accepted, stack) >>> 0, 1,
    'a subclass chained to a WAT-native control accepts WM_NCCREATE');

  console.log('PASS CreateWindowEx rejects failed WM_NCCREATE/WM_CREATE transactions');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
