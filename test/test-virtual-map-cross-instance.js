#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileSrcWasm } = require('./compile-src');
const { createHostImports } = require('../lib/host-imports');
// $VIRTUAL_MAP_STATE, $VIRTUAL_MAP_TABLE and $VIRTUAL_BACKING_BASE, from the
// map declared in src/00-regions.wat. (The bare 0x2000/0x3000/0x4000/0x5000
// below are allocation SIZES, not the regions the census reads them as.)
const RegionMap = require('../lib/region-map.generated.js');
const MAP_STATE = RegionMap.BASE.VIRTUAL_MAP_STATE;
const MAP_TABLE = RegionMap.BASE.VIRTUAL_MAP_TABLE;

const extraWat = String.raw`
  (func (export "test_virtual_reset")
    (call $zero_memory (global.get $VIRTUAL_MAP_STATE)
      (i32.add (global.get $VIRTUAL_MAP_STATE_SIZE)
        (global.get $VIRTUAL_MAP_TABLE_SIZE)))
    (call $zero_memory (global.get $GUEST_PAGE_TABLE)
      (global.get $GUEST_PAGE_TABLE_SIZE))
    (i32.store (i32.add (global.get $VIRTUAL_MAP_STATE) (i32.const 4))
      (global.get $VIRTUAL_BACKING_BASE))
    (global.set $virtual_alloc_top (global.get $VIRTUAL_ALLOC_TOP_INIT))
    (global.set $heap_sparse_ptr (i32.const 0))
    (global.set $heap_sparse_end (i32.const 0)))
  (func (export "test_virtual_worker_reset")
    (global.set $virtual_alloc_top (global.get $VIRTUAL_ALLOC_TOP_INIT))
    (global.set $heap_sparse_ptr (i32.const 0))
    (global.set $heap_sparse_end (i32.const 0)))
  (func (export "test_virtual_alloc_null") (param $size i32) (result i32)
    (global.set $esp (i32.const 0x00500000))
    (call $handle_VirtualAlloc
      (i32.const 0) (local.get $size) (i32.const 0x2000)
      (i32.const 0x04) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_virtual_alloc_commit") (param $size i32) (result i32)
    (global.set $esp (i32.const 0x00500000))
    (call $handle_VirtualAlloc
      (i32.const 0) (local.get $size) (i32.const 0x3000)
      (i32.const 0x04) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_virtual_free") (param $guest i32) (result i32)
    (global.set $esp (i32.const 0x00500000))
    (call $handle_VirtualFree
      (local.get $guest) (i32.const 0) (i32.const 0x8000)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_virtual_lock") (param $guest i32) (param $size i32) (result i32)
    (global.set $esp (i32.const 0x00500000))
    (call $handle_VirtualLock
      (local.get $guest) (local.get $size) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_virtual_unlock") (param $guest i32) (param $size i32) (result i32)
    (global.set $esp (i32.const 0x00500000))
    (call $handle_VirtualUnlock
      (local.get $guest) (local.get $size) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_virtual_commit") (param $guest i32) (param $size i32) (result i32)
    (call $virtual_map_commit (local.get $guest) (local.get $size)))
  (func (export "test_virtual_write32") (param $guest i32) (param $value i32)
    (call $gs32 (local.get $guest) (local.get $value)))
  (func (export "test_virtual_read32") (param $guest i32) (result i32)
    (call $gl32 (local.get $guest)))
  (func (export "test_sparse_heap_alloc") (param $size i32) (result i32)
    (call $heap_sparse_alloc (local.get $size)))
  (func (export "test_heap_reset") (param $base i32)
    (global.set $heap_base (local.get $base))
    (global.set $heap_ptr (local.get $base))
    (global.set $free_list (i32.const 0))
    (global.set $heap_sparse_ptr (i32.const 0))
    (global.set $heap_sparse_end (i32.const 0)))
  (func (export "test_heap_alloc") (param $size i32) (result i32)
    (call $heap_alloc (local.get $size)))
  (func (export "test_heap_free") (param $ptr i32)
    (call $heap_free (local.get $ptr)))
`;

async function main() {
  const srcDir = path.join(__dirname, '..', 'src');
  // Plain append: src fragments are self-balanced now, so there is no trailing
  // `)` to splice before — the old regex matched nothing and dropped extraWat.
  const wasmBytes = compileSrcWasm((filename, source) =>
    filename === '13-exports.wat' ? `${source}\n${extraWat}\n` : source);
  const memory = new WebAssembly.Memory({
    initial: 8192, maximum: 8192, shared: true,
  });

  async function instantiate() {
    const context = {
      getMemory: () => memory.buffer,
      renderer: null,
      resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
      onExit: () => {},
    };
    const imports = createHostImports(context);
    imports.host.memory = memory;
    imports.host.create_thread = () => 0;
    imports.host.exit_thread = () => 0;
    imports.host.terminate_thread = () => 0;
    imports.host.create_event = () => 0;
    imports.host.set_event = () => 0;
    imports.host.reset_event = () => 0;
    imports.host.wait_single = () => 0;
    imports.host.wait_multiple = () => 0;
    imports.host.com_create_instance = () => 0x80004002;
    const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
    context.exports = instance.exports;
    return instance.exports;
  }

  const main = await instantiate();
  const worker = await instantiate();
  main.test_virtual_reset();
  worker.test_virtual_worker_reset();

  assert.strictEqual(main.test_virtual_lock(0x00401000, 0x1000), 1,
    'resident guest memory must be lockable');
  assert.strictEqual(main.test_virtual_unlock(0x00401000, 0x1000), 1,
    'a non-empty locked range must be unlockable');
  assert.strictEqual(main.test_virtual_lock(0, 0x1000), 0,
    'VirtualLock must reject a null base');
  assert.strictEqual(main.test_virtual_unlock(0x00401000, 0), 0,
    'VirtualUnlock must reject an empty range');

  const graphicsSize = 0x00a90000;
  const graphicsBase = main.test_virtual_alloc_null(graphicsSize) >>> 0;
  assert.strictEqual(graphicsBase, 0x4f570000,
    'the first reservation should retain the legacy high-arena address');

  // Model Blobby's exact order: the main thread reserves its graphics arena
  // without MEM_COMMIT, then a worker spills HeapAlloc into sparse memory.
  const heapBlock = worker.test_sparse_heap_alloc(0x5000) >>> 0;
  assert(heapBlock < graphicsBase,
    'worker sparse heap must be placed below the main reservation');
  assert(!(heapBlock >= graphicsBase && heapBlock < graphicsBase + graphicsSize),
    'worker sparse heap must not alias the reserved graphics arena');

  const committed = main.test_virtual_commit(graphicsBase, graphicsSize) >>> 0;
  assert.strictEqual(committed, graphicsBase,
    'committing a reservation later must preserve its guest address');

  const state = new DataView(memory.buffer);
  const mapCount = state.getUint32(MAP_STATE, true);
  assert.strictEqual(mapCount, 1,
    'adjacent heap and graphics backing should coalesce into one sparse map');
  assert.strictEqual(state.getUint32(MAP_TABLE, true), heapBlock,
    'the coalesced sparse map should begin at the worker heap reservation');
  assert.strictEqual(state.getUint32(MAP_TABLE + 4, true), graphicsSize + 0x00100000,
    'the coalesced sparse map should cover each reservation exactly once');
  const graphicsBacking = state.getUint32(MAP_TABLE + 8, true) +
    (graphicsBase - heapBlock);
  assert.strictEqual(main.guest_to_wasm(graphicsBase) >>> 0, graphicsBacking >>> 0,
    'packed translation must resolve the main instance mapping');
  assert.strictEqual(worker.guest_to_wasm(graphicsBase) >>> 0, graphicsBacking >>> 0,
    'packed translations published by one instance must be visible to workers');
  assert.strictEqual(main.get_guest_page_table_size(), 0x400000,
    'packed translation must cover all 4GB with one flat PTE array');

  // The former two-level directory covered only addresses below 2GB. The flat
  // index is deliberately unsigned and covers the upper half as well, even
  // though ordinary Win98 VirtualAlloc(NULL, ...) currently chooses lower
  // addresses from its own arena.
  main.test_virtual_reset();
  const upperGuest = 0x90001000;
  assert.strictEqual(main.test_virtual_commit(upperGuest, 0x1000) >>> 0, upperGuest,
    'a high-bit guest address must fit the complete flat page table');
  main.test_virtual_write32(upperGuest + 0xabc, 0x89abcdef);
  assert.strictEqual(worker.test_virtual_read32(upperGuest + 0xabc) >>> 0, 0x89abcdef,
    'workers must translate packed PTEs in the upper half of guest space');
  assert.strictEqual(main.test_virtual_free(upperGuest) >>> 0, 1,
    'an upper-half packed mapping must remain releasable');
  assert.strictEqual(worker.guest_to_wasm(upperGuest) >>> 0, 0xf0,
    'upper-half PTE release must become visible across instances');

  // A cleared PTE is authoritative. In particular, do not resurrect released
  // backing by consulting the allocation metadata table after MEM_RELEASE.
  main.test_virtual_reset();
  const released = main.test_virtual_alloc_commit(0x2000) >>> 0;
  const releasedBacking = main.guest_to_wasm(released) >>> 0;
  assert.notStrictEqual(releasedBacking, 0xf0,
    'freshly committed page must have packed backing');
  main.test_virtual_write32(released, 0x7b);
  assert.strictEqual(main.guest_read8(released), 0x7b,
    'byte read must observe the live sparse mapping');
  assert.strictEqual(main.test_virtual_free(released) >>> 0, 1,
    'packed mapping should remain releasable');
  assert.strictEqual(main.guest_to_wasm(released) >>> 0, 0xf0,
    'released packed mapping must become unmapped immediately');
  assert.strictEqual(main.guest_read8(released), 0,
    'byte reads must not retain a per-instance translation after release');

  // Storm's image preload performs more than 2048 short-lived reserve/commit
  // cycles. Returning success from VirtualFree without removing mappings made
  // the 2049th allocation fail despite every prior block having been released.
  main.test_virtual_reset();
  for (let i = 0; i < 2500; i++) {
    const block = main.test_virtual_alloc_commit(0x1000) >>> 0;
    assert.notStrictEqual(block, 0,
      `short-lived sparse allocation ${i} must not exhaust map slots`);
    assert.strictEqual(main.test_virtual_free(block) >>> 0, 1,
      `MEM_RELEASE ${i} should succeed`);
  }
  assert.strictEqual(state.getUint32(MAP_STATE, true), 0,
    'released sparse mappings must recover their table slots');
  assert.strictEqual(state.getUint32(MAP_STATE + 4, true), RegionMap.BASE.VIRTUAL_BACKING_BASE,
    'LIFO sparse releases must recover their topmost backing extent');

  // MSVBVM60 reserves once, then commits the same base with successively
  // larger sizes while generating event-dispatch thunks into the range.
  // These must remain one coherent mapping rather than overlapping shadows.
  main.test_virtual_reset();
  const thunkBase = main.test_virtual_alloc_null(0x10000) >>> 0;
  assert.strictEqual(main.test_virtual_commit(thunkBase, 0x1000) >>> 0, thunkBase);
  main.test_virtual_write32(thunkBase + 0x800, 0x11223344);
  for (const size of [0x2000, 0x3000, 0x4000, 0x5000, 0x6000]) {
    assert.strictEqual(main.test_virtual_commit(thunkBase, size) >>> 0, thunkBase,
      `same-base commit through 0x${size.toString(16)} must succeed`);
  }
  main.test_virtual_write32(thunkBase + 0x5258, 0x55667788);
  assert.strictEqual(main.test_virtual_read32(thunkBase + 0x800) >>> 0, 0x11223344,
    'growing a same-base commit must preserve the generated prefix');
  assert.strictEqual(main.test_virtual_read32(thunkBase + 0x5258) >>> 0, 0x55667788,
    'the grown tail must translate through the same coherent mapping');
  assert.strictEqual(state.getUint32(MAP_STATE, true), 1,
    'progressive same-base commits must not append overlapping sparse maps');
  assert.strictEqual(state.getUint32(MAP_TABLE + 4, true), 0x6000,
    'the coherent map must grow to the largest committed size');

  // MSVC's small-block heap commits three adjacent 64 KiB runs, decommits
  // individual pages near the end, then recommits a 64 KiB run beginning
  // inside the last existing run. The new range extends beyond that run, so
  // it must add only its tail rather than overlaying the first five pages with
  // a second backing store.
  main.test_virtual_reset();
  const arenaBase = main.test_virtual_alloc_null(0x400000) >>> 0;
  for (const offset of [0, 0x10000, 0x20000]) {
    assert.strictEqual(main.test_virtual_commit(arenaBase + offset, 0x10000) >>> 0,
      arenaBase + offset, 'adjacent arena commits must succeed');
  }
  assert.strictEqual(main.test_virtual_commit(arenaBase + 0x2b000, 0x10000) >>> 0,
    arenaBase + 0x2b000, 'partially overlapping tail commit must succeed');
  main.test_virtual_write32(arenaBase + 0x2c000, 0x11223344);
  main.test_virtual_write32(arenaBase + 0x30000, 0x55667788);
  assert.strictEqual(main.test_virtual_read32(arenaBase + 0x2c000) >>> 0, 0x11223344,
    'overlapping prefix and extended tail must share one backing translation');
  assert.strictEqual(main.test_virtual_read32(arenaBase + 0x30000) >>> 0, 0x55667788,
    'the non-overlapping extension must remain writable');
  assert.strictEqual(state.getUint32(MAP_STATE, true), 1,
    'a partial-tail commit must not append an overlapping sparse map');
  assert.strictEqual(state.getUint32(MAP_TABLE + 4, true), 0x3b000,
    'the arena map must grow only through the recommitted tail');

  // JigSawedME exposed a stale title-table value whose bytes spell "ACTR".
  // A lower-bound-only ownership check accepted it as a heap pointer and made
  // the next CreateWindowEx allocation loop through arbitrary memory forever.
  main.test_heap_reset(0x00650000);
  const owned = main.test_heap_alloc(24) >>> 0;
  main.test_heap_free(0x52544345);
  assert.strictEqual(main.get_free_list() >>> 0, 0,
    'a foreign high pointer must not poison the allocator free list');
  main.test_heap_free(owned);
  assert.strictEqual(main.get_free_list() >>> 0, (owned - 4) >>> 0,
    'a validated direct-heap allocation must remain reusable');

  console.log('PASS  cross-instance sparse reservations remain disjoint');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
