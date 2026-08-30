#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_shell_malloc") (param $out i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $init_dx_com_thunks)
    (call $gs32 (local.get $out) (i32.const 0xdeadbeef))
    (call $handle_SHGetMalloc (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_shell_malloc_null") (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SHGetMalloc (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const out = 0x2400;
  assert.strictEqual(wat.test_shell_malloc(out) >>> 0, 0,
    'SHGetMalloc succeeds for a writable output pointer');
  const allocator = wat.guest_read32(out) >>> 0;
  assert.notStrictEqual(allocator, 0, 'SHGetMalloc returns a live IMalloc object');
  const vtable = wat.guest_read32(allocator) >>> 0;
  assert.notStrictEqual(vtable, 0, 'shell IMalloc has a vtable');
  assert.notStrictEqual(wat.guest_read32(vtable + 5 * 4) >>> 0, 0,
    'shell IMalloc exposes the Free method used for PIDLs');
  assert.strictEqual(wat.get_esp(), 0x00300008,
    'one-argument SHGetMalloc has the correct stdcall cleanup');
  assert.strictEqual(wat.test_shell_malloc_null() >>> 0, 0x80004003,
    'SHGetMalloc rejects a null output pointer with E_POINTER');
  assert.strictEqual(wat.get_esp(), 0x00300008,
    'SHGetMalloc failure preserves stdcall cleanup');
  console.log('PASS  SHGetMalloc returns the process-local IMalloc used to free shell PIDLs');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
