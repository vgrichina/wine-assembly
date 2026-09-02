#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_register_a") (param $wc i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_RegisterClassA
      (local.get $wc) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_register_w") (param $wc i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_RegisterClassW
      (local.get $wc) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_unregister_a")
      (param $name i32) (param $instance i32) (param $stack i32) (result i64)
    (global.set $esp (local.get $stack))
    (call $handle_UnregisterClassA
      (local.get $name) (local.get $instance) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_unregister_w")
      (param $name i32) (param $instance i32) (param $stack i32) (result i64)
    (global.set $esp (local.get $stack))
    (call $handle_UnregisterClassW
      (local.get $name) (local.get $instance) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_lookup_a") (param $name i32) (result i32)
    (call $class_table_lookup (call $class_name_key (local.get $name))))
  (func (export "test_lookup_w") (param $name i32) (result i32)
    (call $class_table_lookup (call $class_wide_name_key (local.get $name))))
  (func (export "test_class_slot") (param $name i32) (result i32)
    (call $class_find_slot (call $class_name_key (local.get $name))))
  (func (export "test_set_class_extra") (param $slot i32) (param $value i32)
    (call $class_extra_set_word (local.get $slot) (i32.const 0) (local.get $value)))
  (func (export "test_get_class_extra") (param $slot i32) (result i32)
    (call $class_extra_get_word (local.get $slot) (i32.const 0)))

  (func (export "test_make_class_window")
      (param $hwnd i32) (param $name i32) (param $proc i32)
    (call $wnd_table_set (local.get $hwnd) (local.get $proc))
    (call $wnd_set_class_slot_from_name (local.get $hwnd) (local.get $name)))
  (func (export "test_remove_window") (param $hwnd i32)
    (call $wnd_table_remove (local.get $hwnd)))

  (func (export "test_set_last_error") (param $value i32)
    (global.set $last_error (local.get $value)))
  (func (export "test_get_last_error") (result i32)
    (global.get $last_error))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: { destroy_window() {} },
  });
  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const stack = 0x074ff000;
  const HINSTANCE_A = 0x00400000;
  const HINSTANCE_W = 0x00600000;
  const PROC_A = 0x00401234;
  const PROC_B = 0x00405678;
  const ERROR_CLASS_DOES_NOT_EXIST = 1411;
  const ERROR_CLASS_HAS_WINDOWS = 1412;

  const ansi = text => {
    const ptr = e.guest_alloc(text.length + 1) >>> 0;
    bytes.set(Buffer.from(`${text}\0`, 'latin1'), toWasm(ptr));
    return ptr;
  };
  const wide = text => {
    const ptr = e.guest_alloc((text.length + 1) * 2) >>> 0;
    const wa = toWasm(ptr);
    for (let i = 0; i < text.length; i++) view.setUint16(wa + i * 2, text.charCodeAt(i), true);
    view.setUint16(wa + text.length * 2, 0, true);
    return ptr;
  };
  const wndclass = (name, instance, proc) => {
    const ptr = e.guest_alloc(40) >>> 0;
    const wa = toWasm(ptr);
    bytes.fill(0, wa, wa + 40);
    view.setUint32(wa + 4, proc, true);
    view.setUint32(wa + 8, 4, true); // cbClsExtra
    view.setUint32(wa + 16, instance, true);
    view.setUint32(wa + 36, name, true);
    return ptr;
  };
  const result = packed => Number(packed & 0xffffffffn) >>> 0;
  const finalEsp = packed => Number(packed >> 32n) >>> 0;

  const missing = ansi('NeverRegistered');
  assert.strictEqual(result(e.test_unregister_a(missing, HINSTANCE_A, stack)), 0);
  assert.strictEqual(e.test_get_last_error(), ERROR_CLASS_DOES_NOT_EXIST,
    'an unknown class reports ERROR_CLASS_DOES_NOT_EXIST');
  assert.strictEqual(result(e.test_unregister_a(ansi('Button'), 0, stack)), 0);
  assert.strictEqual(e.test_get_last_error(), ERROR_CLASS_DOES_NOT_EXIST,
    'a system class cannot be unregistered by name');
  assert.strictEqual(result(e.test_unregister_a(0x80, 0, stack)), 0,
    'a system class cannot be unregistered by atom');

  const nameA = ansi('UnregisterLifecycleA');
  const atomA = e.test_register_a(wndclass(nameA, HINSTANCE_A, PROC_A)) >>> 0;
  assert(atomA >= 0xc001, 'RegisterClassA returns an application class atom');
  assert.strictEqual(e.test_lookup_a(nameA) >>> 0, PROC_A);
  const slotA = e.test_class_slot(nameA);
  assert(slotA >= 0, 'registered class owns a table slot');
  e.test_set_class_extra(slotA, 0xbeef);

  assert.strictEqual(result(e.test_unregister_a(nameA, HINSTANCE_W, stack)), 0);
  assert.strictEqual(e.test_get_last_error(), ERROR_CLASS_DOES_NOT_EXIST,
    'the module handle must match the class owner');
  assert.strictEqual(e.test_lookup_a(nameA) >>> 0, PROC_A,
    'an owner mismatch leaves the class registered');

  const hwnd = 0x10080;
  e.test_make_class_window(hwnd, nameA, PROC_A);
  assert.strictEqual(result(e.test_unregister_a(atomA, HINSTANCE_A, stack)), 0);
  assert.strictEqual(e.test_get_last_error(), ERROR_CLASS_HAS_WINDOWS,
    'an atom lookup refuses removal while a class window survives');
  assert.strictEqual(e.test_lookup_a(nameA) >>> 0, PROC_A,
    'live-window refusal leaves the class registered');
  e.test_remove_window(hwnd);

  e.test_set_last_error(0x1234);
  let packed = e.test_unregister_a(atomA, HINSTANCE_A, stack);
  assert.strictEqual(result(packed), 1, 'class atom unregisters after its last window closes');
  assert.strictEqual(finalEsp(packed), stack + 12, 'UnregisterClassA cleans two stdcall arguments');
  assert.strictEqual(e.test_get_last_error(), 0x1234,
    'successful UnregisterClass leaves LastError unchanged');
  assert.strictEqual(e.test_lookup_a(nameA), 0, 'removed class is no longer discoverable');
  assert.strictEqual(result(e.test_unregister_a(atomA, HINSTANCE_A, stack)), 0,
    'a stale class atom cannot be reused');
  assert.strictEqual(e.test_get_last_error(), ERROR_CLASS_DOES_NOT_EXIST);

  const nameB = ansi('ReusedClassSlot');
  e.test_register_a(wndclass(nameB, HINSTANCE_A, PROC_B));
  const slotB = e.test_class_slot(nameB);
  assert.strictEqual(slotB, slotA, 'the removed class slot is reusable');
  assert.strictEqual(e.test_get_class_extra(slotB), 0,
    'slot reuse does not inherit the old class-extra bytes');
  assert.strictEqual(result(e.test_unregister_a(nameB, HINSTANCE_A, stack)), 1);

  const nameW = wide('UnicodeApiClass');
  e.test_register_w(wndclass(nameW, HINSTANCE_W, PROC_B));
  assert.strictEqual(e.test_lookup_w(nameW) >>> 0, PROC_B,
    'RegisterClassW publishes the canonical class');
  e.test_set_last_error(0x5678);
  packed = e.test_unregister_w(nameW, HINSTANCE_W, stack);
  assert.strictEqual(result(packed), 1, 'UnregisterClassW decodes its UTF-16 name');
  assert.strictEqual(finalEsp(packed), stack + 12, 'UnregisterClassW cleans two stdcall arguments');
  assert.strictEqual(e.test_get_last_error(), 0x5678,
    'successful wide removal also preserves LastError');
  assert.strictEqual(e.test_lookup_w(nameW), 0);

  console.log('PASS UnregisterClassA/W enforce Win98 class ownership and lifetime');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
