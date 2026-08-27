#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
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
  (func (export "test_init_image_base")
    (global.set $image_base (i32.const 0x00400000)))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const name = 0x00402600;
  const value = 'uxtheme.dll';
  wat.test_init_image_base();
  for (let i = 0; i <= value.length; i++) {
    const code = i < value.length ? value.charCodeAt(i) : 0;
    wat.guest_write8(name + i * 2, code & 0xff);
    wat.guest_write8(name + i * 2 + 1, code >>> 8);
  }

  assert.strictEqual(wat.test_wide_uxtheme_match(name), 1,
    'mapped UTF-16 module name matches the static optional-DLL name');
  assert.strictEqual(wat.test_wide_uxtheme_gate(name), 1,
    'a naturally aligned UTF-16 pointer does not mask a successful match');
  assert.strictEqual(wat.test_load_library_ex_w(name, 0, 2), 0,
    'Unicode wrapper preserves the optional-uxtheme unavailable result');
  assert.strictEqual(wat.get_esp(), 0x00300010,
    'three-argument stdcall pops return address plus all arguments');

  console.log('PASS LoadLibraryExW delegates Unicode lookup and consumes three arguments');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
