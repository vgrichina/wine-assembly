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
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const name = 0x2600;
  const value = 'uxtheme.dll';
  for (let i = 0; i <= value.length; i++) {
    const code = i < value.length ? value.charCodeAt(i) : 0;
    wat.guest_write8(name + i * 2, code & 0xff);
    wat.guest_write8(name + i * 2 + 1, code >>> 8);
  }

  assert.strictEqual(wat.test_load_library_ex_w(name, 0, 2), 0x00400000,
    'Unicode wrapper preserves LoadLibraryW result');
  assert.strictEqual(wat.get_esp(), 0x00300010,
    'three-argument stdcall pops return address plus all arguments');

  console.log('PASS LoadLibraryExW delegates Unicode lookup and consumes three arguments');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
