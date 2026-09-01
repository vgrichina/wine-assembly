#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_process_heap") (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetProcessHeap
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_heap_create") (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_HeapCreate
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_heap_destroy") (param $heap i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_HeapDestroy
      (local.get $heap) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_heap_alloc") (param $heap i32) (param $flags i32) (param $size i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_HeapAlloc
      (local.get $heap) (local.get $flags) (local.get $size)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_heap_free") (param $heap i32) (param $ptr i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_HeapFree
      (local.get $heap) (i32.const 0) (local.get $ptr)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_heap_realloc") (param $heap i32) (param $ptr i32) (param $size i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_HeapReAlloc
      (local.get $heap) (i32.const 0) (local.get $ptr) (local.get $size)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_heap_size") (param $heap i32) (param $ptr i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_HeapSize
      (local.get $heap) (i32.const 0) (local.get $ptr)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_heap_set_information") (param $heap i32) (param $info_class i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_HeapSetInformation
      (local.get $heap) (local.get $info_class) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_last_error") (result i32)
    (global.get $last_error))
`;

(async () => {
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const main = await bootRenderHarness({ extraWat, fonts: 'none', memory });
  const worker = await bootRenderHarness({ extraWat, fonts: 'none', memory });
  const a = main.exports;
  const b = worker.exports;

  const processHeap = a.test_get_process_heap() >>> 0;
  assert(processHeap, 'GetProcessHeap returns a stable nonzero handle');
  assert.strictEqual(b.test_get_process_heap() >>> 0, processHeap,
    'all browser Worker instances see the same process heap handle');
  assert.strictEqual(a.test_heap_destroy(processHeap), 0,
    'HeapDestroy rejects the process heap');
  assert.strictEqual(a.test_last_error(), 6);
  const processAllocation = a.test_heap_alloc(processHeap, 0, 12) >>> 0;
  assert(processAllocation, 'the process heap remains usable');
  assert.strictEqual(a.test_heap_free(processHeap, processAllocation), 1);

  const first = a.test_heap_create() >>> 0;
  const second = a.test_heap_create() >>> 0;
  assert(first && second, 'HeapCreate allocates private heap records');
  assert.notStrictEqual(first, second, 'each HeapCreate call has distinct identity');
  assert.notStrictEqual(first, processHeap);
  assert.strictEqual(a.test_heap_set_information(processHeap, 0), 1,
    'HeapSetInformation accepts the process heap');
  assert.strictEqual(a.test_heap_set_information(first, 0), 1,
    'HeapSetInformation accepts private heap handles');

  const firstAllocation = b.test_heap_alloc(first, 0x08, 32) >>> 0;
  assert(firstAllocation,
    'a private heap created by the main guest is usable from a browser Worker');
  for (let i = 0; i < 32; i++) {
    assert.strictEqual(b.guest_read8(firstAllocation + i), 0,
      'HEAP_ZERO_MEMORY still applies to private heaps');
  }
  assert.strictEqual(b.test_heap_free(first, firstAllocation), 1,
    'the Worker can free its allocation through the same private heap');

  assert.strictEqual(b.test_heap_destroy(first), 1,
    'private heap lifetime is process-wide rather than instance-local');
  assert.strictEqual(a.test_heap_alloc(first, 0, 8), 0,
    'a destroyed heap cannot be reused by another guest thread');
  assert.strictEqual(a.test_last_error(), 6);
  assert.strictEqual(a.test_heap_realloc(first, 0, 8), 0,
    'HeapReAlloc rejects a destroyed heap');
  assert.strictEqual(a.test_last_error(), 6);
  assert.strictEqual(a.test_heap_size(first, firstAllocation) >>> 0, 0xffffffff,
    'HeapSize rejects a destroyed heap');
  assert.strictEqual(a.test_last_error(), 6);
  assert.strictEqual(a.test_heap_destroy(first), 0,
    'destroying the same heap twice fails');
  assert.strictEqual(a.test_last_error(), 6);
  assert.strictEqual(a.test_heap_set_information(first, 0), 0,
    'HeapSetInformation rejects destroyed heaps');
  assert.strictEqual(a.test_last_error(), 6);

  const secondAllocation = a.test_heap_alloc(second, 0, 16) >>> 0;
  assert(secondAllocation, 'destroying one private heap leaves another usable');
  assert.strictEqual(a.test_heap_free(second, secondAllocation), 1);
  assert.strictEqual(a.test_heap_destroy(second), 1);

  assert.strictEqual(a.test_heap_alloc(0x00140000, 0, 8), 0,
    'the former fixed fake heap token is no longer accepted');
  assert.strictEqual(a.test_last_error(), 6);
  assert.strictEqual(a.test_heap_set_information(0x00140000, 0), 0,
    'HeapSetInformation rejects invalid heap handles');
  assert.strictEqual(a.test_last_error(), 6);

  console.log('PASS  HeapCreate uses distinct shared-lifetime browser handles');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
