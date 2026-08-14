#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileWat } = require('../lib/compile-wat');
const { createHostImports } = require('../lib/host-imports');

const extraWat = String.raw`
  (func (export "test_virtual_reset")
    (call $zero_memory (global.get $VIRTUAL_MAP_STATE)
      (i32.add (global.get $VIRTUAL_MAP_STATE_SIZE)
        (global.get $VIRTUAL_MAP_TABLE_SIZE)))
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
  (func (export "test_virtual_commit") (param $guest i32) (param $size i32) (result i32)
    (call $virtual_map_commit (local.get $guest) (local.get $size)))
  (func (export "test_sparse_heap_alloc") (param $size i32) (result i32)
    (call $heap_sparse_alloc (local.get $size)))
`;

async function main() {
  const srcDir = path.join(__dirname, '..', 'src');
  const wasmBytes = await compileWat(async filename => {
    const source = await fs.promises.readFile(path.join(srcDir, filename), 'utf8');
    if (filename !== '13-exports.wat') return source;
    return source.replace(/\n\)\s*$/, `\n${extraWat}\n)\n`);
  });
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

  const graphicsSize = 0x00a90000;
  const graphicsBase = main.test_virtual_alloc_null(graphicsSize) >>> 0;
  assert.strictEqual(graphicsBase, 0x3f570000,
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
  const mapCount = state.getUint32(0x07f02400, true);
  assert.strictEqual(mapCount, 1,
    'adjacent heap and graphics backing should coalesce into one sparse map');
  assert.strictEqual(state.getUint32(0x07f02410, true), heapBlock,
    'the coalesced sparse map should begin at the worker heap reservation');
  assert.strictEqual(state.getUint32(0x07f02414, true), graphicsSize + 0x00100000,
    'the coalesced sparse map should cover each reservation exactly once');

  console.log('PASS  cross-instance sparse reservations remain disjoint');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
