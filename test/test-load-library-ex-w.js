#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_load_library_ex_a") (param $name i32) (param $file i32) (param $flags i32) (result i32)
    (global.set $image_base (i32.const 0x00400000))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_LoadLibraryExA
      (local.get $name) (local.get $file) (local.get $flags)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_load_library_ex_w") (param $name i32) (param $file i32) (param $flags i32) (result i32)
    (global.set $image_base (i32.const 0x00400000))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_LoadLibraryExW
      (local.get $name) (local.get $file) (local.get $flags)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_wide_uxtheme_match") (param $name i32) (result i32)
    (global.set $image_base (i32.const 0x00400000))
    (call $wide_ascii_eq (call $g2w (local.get $name)) (i32.const 0x36D)))
  (func (export "test_wide_uxtheme_gate") (param $name i32) (result i32)
    (global.set $image_base (i32.const 0x00400000))
    (i32.and (i32.ne (local.get $name) (i32.const 0))
      (call $wide_ascii_eq (call $g2w (local.get $name)) (i32.const 0x36D))))
  (func (export "test_co_load_library") (param $name i32) (param $auto_free i32) (result i32)
    (global.set $image_base (i32.const 0x00400000))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_CoLoadLibrary
      (local.get $name) (local.get $auto_free) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_init_image_base")
    (global.set $image_base (i32.const 0x00400000)))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const name = 0x00402600;
  const ansiName = 0x00402700;
  const value = 'uxtheme.dll';
  wat.test_init_image_base();
  for (let i = 0; i <= value.length; i++) {
    const code = i < value.length ? value.charCodeAt(i) : 0;
    wat.guest_write8(name + i * 2, code & 0xff);
    wat.guest_write8(name + i * 2 + 1, code >>> 8);
  }
  for (let i = 0; i <= value.length; i++) {
    wat.guest_write8(ansiName + i, i < value.length ? value.charCodeAt(i) : 0);
  }

  assert.strictEqual(wat.test_wide_uxtheme_match(name), 1,
    'mapped UTF-16 module name matches the static optional-DLL name');
  assert.strictEqual(wat.test_wide_uxtheme_gate(name), 1,
    'a naturally aligned UTF-16 pointer does not mask a successful match');
  assert.strictEqual(wat.test_load_library_ex_w(name, 0, 2), 0,
    'Unicode wrapper preserves the optional-uxtheme unavailable result');
  assert.strictEqual(wat.get_esp(), 0x00300010,
    'three-argument stdcall pops return address plus all arguments');
  assert.strictEqual(wat.test_co_load_library(name, 1), 0,
    'CoLoadLibrary preserves the Unicode loader result');
  assert.strictEqual(wat.get_esp(), 0x0030000c,
    'CoLoadLibrary consumes its return address and both arguments');

  assert.strictEqual(wat.test_load_library_ex_a(ansiName, 0, 2), 0,
    'ANSI wrapper shares the optional-uxtheme unavailable result');
  assert.strictEqual(wat.get_esp(), 0x00300010,
    'ANSI three-argument stdcall pops return address plus all arguments');

  let yieldingMemory = null;
  let requestedName = '';
  const { exports: yielding, memory } = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      has_dll_file: nameWA => {
        assert(yieldingMemory, 'host lookup runs after the harness is ready');
        const bytes = new Uint8Array(yieldingMemory.buffer);
        requestedName = '';
        for (let i = nameWA >>> 0; i < bytes.length && bytes[i]; i++) {
          requestedName += String.fromCharCode(bytes[i]);
        }
        return requestedName === 'plugin.dll' ? 1 : 0;
      },
    },
  });
  yieldingMemory = memory;
  yielding.test_init_image_base();
  const dynamicName = 0x00402800;
  const dynamicValue = 'plugin.dll';
  for (let i = 0; i <= dynamicValue.length; i++) {
    const code = i < dynamicValue.length ? dynamicValue.charCodeAt(i) : 0;
    yielding.guest_write8(dynamicName + i * 2, code & 0xff);
    yielding.guest_write8(dynamicName + i * 2 + 1, code >>> 8);
  }
  yielding.test_load_library_ex_w(dynamicName, 0, 0);
  assert.strictEqual(requestedName, dynamicValue,
    'Unicode module name is staged at the guest alias visible to the host');
  assert.strictEqual(yielding.get_yield_reason(), 5,
    'Unicode dynamic DLL lookup preserves the loader yield reason');
  assert.strictEqual(yielding.get_yield_flag(), 1,
    'Unicode dynamic DLL lookup preserves the loader yield flag');
  assert.strictEqual(yielding.get_esp(), 0x00300010,
    'yielding LoadLibraryExW still consumes all three arguments');

  console.log('PASS ANSI/Unicode/COM library wrappers delegate lookup, preserve yields, and consume their arguments');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
