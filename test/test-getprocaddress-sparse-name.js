#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (global $test_sparse_thunk (mut i32) (i32.const 0))

  (func (export "test_get_proc_sparse") (param $stack i32) (result i32)
    (local $name i32)
    (local.set $name (call $heap_alloc (i32.const 13)))
    (i32.store (call $g2w (local.get $name)) (i32.const 0x54746547)) ;; "GetT"
    (i32.store offset=4 (call $g2w (local.get $name)) (i32.const 0x436b6369)) ;; "ickC"
    (i32.store offset=8 (call $g2w (local.get $name)) (i32.const 0x746e756f)) ;; "ount"
    (i32.store8 offset=12 (call $g2w (local.get $name)) (i32.const 0))

    ;; Exhaust the direct heap cursor so GetProcAddress's private copy of the
    ;; import name must come from a sparse high guest mapping.
    (global.set $heap_ptr (i32.const 0))
    (global.set $heap_end (i32.const 0))
    (i32.atomic.store (global.get $HEAP_SHARED) (i32.const -1))

    (global.set $esp (local.get $stack))
    (call $handle_GetProcAddress
      (global.get $image_base) (local.get $name) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_sparse_thunk
      (i32.sub (global.get $num_thunks) (i32.const 1)))
    (global.get $eax))

  (func (export "test_sparse_name_length") (result i32)
    (local $name_rva i32)
    (local.set $name_rva
      (i32.load (i32.add (global.get $THUNK_BASE)
        (i32.mul (global.get $test_sparse_thunk) (i32.const 8)))))
    (call $strlen
      (i32.add (global.get $GUEST_BASE)
        (i32.add (local.get $name_rva) (i32.const 2)))))

  (func (export "test_dispatch_sparse_thunk") (param $stack i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $gs32 (local.get $stack) (i32.const 0x12345678))
    (call $win32_dispatch (global.get $test_sparse_thunk))
    (global.get $esp))

  (func (export "test_sparse_heap_active") (result i32)
    (global.get $heap_sparse_ptr))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const stack = 0x074ff000;

  assert.notStrictEqual(wat.test_get_proc_sparse(stack) >>> 0, 0,
    'GetProcAddress(GetTickCount) returns a dynamic thunk');
  assert.notStrictEqual(wat.test_sparse_heap_active() >>> 0, 0,
    'GetProcAddress copied the import name into the sparse heap');
  assert.strictEqual(wat.test_sparse_name_length() >>> 0, 12,
    'dynamic thunk reconstructs its sparse import name in WASM backing memory');
  assert.strictEqual(wat.test_dispatch_sparse_thunk(stack) >>> 0, stack + 4,
    'dispatch reads the sparse import name and calls the API without trapping');

  console.log('PASS  GetProcAddress dispatches names allocated in sparse guest memory');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
