#!/usr/bin/env node
const assert = require('assert');
const { ThreadManager } = require('../lib/thread-manager');

(async () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const mainInstance = {
    exports: {
      get_sync_table: () => 0,
      get_bp_addr: () => 0,
      get_watch_addr: () => 0,
    },
  };
  let generation = 1;
  let nextSlot = 1;
  const spawned = [];
  const workerBackend = {
    async readExports() {
      return {
        get_image_base: 0x400000,
        get_code_start: 0x401000,
        get_code_end: 0x500000,
        get_thunk_base: 0x700000,
        get_thunk_end: 0x710000 + generation * 0x1000,
        get_num_thunks: 100 + generation,
        get_dll_count: 3 + generation,
        get_vlan_local_ip: 0x0a000001,
        get_tls_next_index: 7 + generation,
      };
    },
    async spawnThread(spec) {
      spawned.push({ ...spec });
      return {
        slot: nextSlot++,
        startEip: spec.startAddr >>> 0,
        startEsp: 0x100000,
      };
    },
  };
  const tm = new ThreadManager({}, memory, mainInstance, () => ({ host: {} }), {
    workerBackend,
  });
  tm._log = () => {};
  tm._clearWorkerCacheSlot = () => {};

  tm.createThread(0x401100, 0, 0x10000, 0);
  await tm._spawnPendingWorkers();
  generation = 2;
  tm.createThread(0x401200, 0, 0x10000, 0);
  await tm._spawnPendingWorkers();

  assert.strictEqual(spawned.length, 2);
  assert.strictEqual(spawned[0].dllCount, 4);
  assert.strictEqual(spawned[1].dllCount, 5,
    'a later Worker must see DLLs loaded after the first Worker spawned');
  assert.strictEqual(spawned[1].numThunks, 102,
    'a later Worker must receive the current thunk high-water mark');
  assert.strictEqual(spawned[1].thunkEnd, 0x712000,
    'a later Worker must receive the current thunk arena end');
  assert.strictEqual(spawned[1].tlsNextIndex, 9,
    'a later Worker must receive the current process TLS index');

  console.log('PASS  Worker thread creation refreshes main-guest metadata per spawn');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
