#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileWat } = require('../lib/compile-wat');
const { createHostImports } = require('../lib/host-imports');

const IMAGE_BASE = 0x400000;
const CS_GUEST = 0x500000;
const CS_WASM = CS_GUEST - IMAGE_BASE + 0x12000;

async function instantiate(wasmBytes, memory, tid) {
  const ctx = {
    getMemory: () => memory.buffer,
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
  };
  const imports = createHostImports(ctx);
  imports.host.memory = memory;
  for (const name of ['create_thread', 'exit_thread', 'create_event',
    'set_event', 'reset_event', 'wait_single', 'wait_multiple']) {
    imports.host[name] = () => 0;
  }
  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  ctx.exports = instance.exports;
  instance.exports.init_thread(tid, IMAGE_BASE, 0, 0, 0, 0, 0);
  return instance.exports;
}

(async () => {
  const src = path.join(__dirname, '..', 'src');
  const wasmBytes = await compileWat(file =>
    fs.promises.readFile(path.join(src, file), 'utf8'));
  const memory = new WebAssembly.Memory({
    initial: 8192, maximum: 8192, shared: true,
  });
  const main = await instantiate(wasmBytes, memory, 0);   // thread id 1
  const worker = await instantiate(wasmBytes, memory, 1); // thread id 2
  const dv = new DataView(memory.buffer);
  const state = () => ({
    lock: dv.getInt32(CS_WASM + 4, true),
    recursion: dv.getInt32(CS_WASM + 8, true),
    owner: dv.getUint32(CS_WASM + 12, true),
  });

  main.test_cs_init(CS_GUEST);
  assert.deepStrictEqual(state(), { lock: -1, recursion: 0, owner: 0 });

  assert.strictEqual(worker.test_cs_park_retry(CS_GUEST), 31,
    'a parked inline EnterCriticalSection resumes at its thunk, completes once, and restores auto-pop');
  assert.deepStrictEqual(state(), { lock: 0, recursion: 1, owner: 2 },
    'the retry owns the section exactly once');
  assert.strictEqual(main.test_cs_enter(CS_GUEST), 7,
    'thread 1 parks instead of stealing a section from even-numbered owner 2');
  assert.deepStrictEqual(state(), { lock: 0, recursion: 1, owner: 2 },
    'an even-numbered owner remains intact while thread 1 is parked');
  worker.test_cs_leave(CS_GUEST);
  assert.deepStrictEqual(state(), { lock: -1, recursion: 0, owner: 0 });

  assert.strictEqual(main.test_cs_enter(CS_GUEST), 0,
    'the main identity acquires a free section without parking');
  assert.deepStrictEqual(state(), { lock: 0, recursion: 1, owner: 1 });
  assert.strictEqual(main.test_cs_enter(CS_GUEST), 0,
    'the owner can recursively enter');
  assert.deepStrictEqual(state(), { lock: 1, recursion: 2, owner: 1 });

  assert.strictEqual(worker.test_cs_enter(CS_GUEST), 7,
    'a contender parks, preserves ESP, and suppresses thunk auto-pop');
  assert.deepStrictEqual(state(), { lock: 1, recursion: 2, owner: 1 },
    'a parked contender cannot mutate the owner state');

  main.test_cs_leave(CS_GUEST);
  assert.deepStrictEqual(state(), { lock: 0, recursion: 1, owner: 1 },
    'one Leave preserves a recursive acquisition');
  main.test_cs_leave(CS_GUEST);
  assert.deepStrictEqual(state(), { lock: -1, recursion: 0, owner: 0 },
    'the final Leave publishes the section as free');

  assert.strictEqual(worker.test_cs_enter(CS_GUEST), 0,
    'the waiter acquires on its retry after release');
  assert.deepStrictEqual(state(), { lock: 0, recursion: 1, owner: 2 });
  main.test_cs_leave(CS_GUEST);
  assert.deepStrictEqual(state(), { lock: 0, recursion: 1, owner: 2 },
    'a non-owner Leave cannot release another live thread');
  worker.test_cs_leave(CS_GUEST);
  assert.deepStrictEqual(state(), { lock: -1, recursion: 0, owner: 0 });

  main.test_cs_leave(CS_GUEST);
  assert.deepStrictEqual(state(), { lock: -1, recursion: 0, owner: 0 },
    'an unmatched Leave cannot drive counters below the initialized state');

  console.log('PASS  cooperative CRITICAL_SECTION ownership, recursion, and parking');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
