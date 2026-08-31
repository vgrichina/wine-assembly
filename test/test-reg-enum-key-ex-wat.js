#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_reg_create_key_a")
        (param $root i32) (param $subkey i32) (param $out i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_RegCreateKeyA
      (local.get $root) (local.get $subkey) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_reg_open_key_a")
        (param $root i32) (param $subkey i32) (param $out i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_RegOpenKeyA
      (local.get $root) (local.get $subkey) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_reg_enum_key_ex_a")
        (param $key i32) (param $index i32) (param $name i32)
        (param $name_len i32) (param $reserved i32) (param $class i32)
        (param $class_len i32) (param $filetime i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (global.set $esp (i32.const 0x00300000))
    (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $class))
    (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (local.get $class_len))
    (call $gs32 (i32.add (global.get $esp) (i32.const 32)) (local.get $filetime))
    (call $handle_RegEnumKeyExA
      (local.get $key) (local.get $index) (local.get $name)
      (local.get $name_len) (local.get $reserved) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const wa = guest => (guest - (e.get_image_base() >>> 0) +
    (e.get_guest_base() >>> 0)) >>> 0;
  const allocA = text => {
    const guest = e.guest_alloc(text.length + 1) >>> 0;
    bytes.set(Buffer.from(text, 'latin1'), wa(guest));
    bytes[wa(guest) + text.length] = 0;
    return guest;
  };
  const readA = guest => {
    let text = '';
    for (let i = 0; i < 128 && bytes[wa(guest) + i]; i++) {
      text += String.fromCharCode(bytes[wa(guest) + i]);
    }
    return text;
  };
  const alloc32 = value => {
    const guest = e.guest_alloc(4) >>> 0;
    view.setUint32(wa(guest), value >>> 0, true);
    return guest;
  };

  const HKCU = 0x80000001;
  const created = alloc32(0);
  assert.strictEqual(e.test_reg_create_key_a(
    HKCU, allocA('Software\\EnumExParent\\Child'), created), 0);
  const parent = alloc32(0);
  assert.strictEqual(e.test_reg_open_key_a(
    HKCU, allocA('Software\\EnumExParent'), parent), 0);
  const handle = view.getUint32(wa(parent), true) >>> 0;
  assert(handle, 'parent registry key opens');

  const name = e.guest_alloc(64) >>> 0;
  const nameLen = alloc32(64);
  const className = e.guest_alloc(16) >>> 0;
  bytes[wa(className)] = 0x58;
  const classLen = alloc32(16);
  const filetime = e.guest_alloc(8) >>> 0;
  view.setUint32(wa(filetime), 0xAAAAAAAA, true);
  view.setUint32(wa(filetime) + 4, 0xBBBBBBBB, true);

  assert.strictEqual(e.test_reg_enum_key_ex_a(
    handle, 0, name, nameLen, 0, className, classLen, filetime), 0);
  assert.strictEqual(readA(name), 'Child');
  assert.strictEqual(view.getUint32(wa(nameLen), true), 5,
    'RegEnumKeyExA returns the copied name length without its terminator');
  assert.strictEqual(view.getUint32(wa(classLen), true), 0);
  assert.strictEqual(bytes[wa(className)], 0,
    'registry class output is a deterministic empty ANSI string');
  assert.strictEqual(view.getUint32(wa(filetime), true), 0);
  assert.strictEqual(view.getUint32(wa(filetime) + 4, true), 0,
    'registry last-write FILETIME is deterministic');

  view.setUint32(wa(nameLen), 64, true);
  assert.strictEqual(e.test_reg_enum_key_ex_a(
    handle, 1, name, nameLen, 0, 0, 0, 0), 259,
  'RegEnumKeyExA reports ERROR_NO_MORE_ITEMS after the final child');
  assert.strictEqual(e.test_reg_enum_key_ex_a(
    handle, 0, name, nameLen, 1, 0, 0, 0), 87,
  'RegEnumKeyExA rejects a non-null reserved argument');

  console.log('PASS RegEnumKeyExA enumerates ANSI subkeys and metadata');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
