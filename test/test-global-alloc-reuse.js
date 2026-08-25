#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_global_alloc") (param $flags i32) (param $size i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GlobalAlloc (local.get $flags) (local.get $size)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  ;; Test-local scaffolding. The module deliberately exports no heap-cursor
  ;; setters — JS used to marshal them between instances to fake shared state,
  ;; and $heap_low_reserve replaces that. A single-instance test still needs a
  ;; known starting arena, so it plants one itself.
  (func (export "test_heap_reset") (param $base i32)
    (global.set $heap_ptr (local.get $base))
    (global.set $free_list (i32.const 0)))
  (func (export "test_global_free") (param $ptr i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GlobalFree (local.get $ptr)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  wat.test_heap_reset(0x00100000);

  const size = 0x1e40;
  const first = wat.test_global_alloc(0, size) >>> 0;
  assert(first, 'initial GlobalAlloc succeeds');
  for (let i = 0; i < size; i++) wat.guest_write8(first + i, (i * 73 + 19) & 0xff);
  wat.test_global_free(first);

  const reused = wat.test_global_alloc(0, size) >>> 0;
  assert.strictEqual(reused, first, 'the regression exercises a recycled heap block');
  for (let i = 0; i < size; i++) {
    assert.strictEqual(wat.guest_read8(reused + i), 0,
      `recycled GlobalAlloc byte ${i} is deterministic zero`);
  }

  console.log('PASS  GlobalAlloc clears recycled blocks before sparse decoders use them');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
