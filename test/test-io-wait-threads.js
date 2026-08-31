#!/usr/bin/env node
// A spawned guest thread that parks on io_wait (yield 12) must be serviced by
// its scheduler, in both backends. Storm reads Diablo's 500MB CD archive on a
// reader thread; in the browser that file is provider-backed (the async File
// API), so every read of a non-resident chunk parks. Before this worked, the
// WAT completed such reads as ERROR_READ_FAULT on any thread but the main one
// and the chain-launched retail game raised its Data File Error dialog.
const assert = require('assert');
const { ThreadManager } = require('../lib/thread-manager');

function makeVfs() {
  const vfs = {
    pendingRead: null,
    fills: [],
    _resolvers: [],
    fillPendingRead(pending) {
      this.fills.push(pending);
      return new Promise(resolve => {
        this._resolvers.push(() => {
          if (this.pendingRead === pending) this.pendingRead = null;
          resolve(true);
        });
      });
    },
    finishFill() {
      const r = this._resolvers.shift();
      if (r) r();
    },
  };
  return vfs;
}

async function testWorkerBackend() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const mainInstance = { exports: { get_sync_table: () => 0, get_bp_addr: () => 0, get_watch_addr: () => 0 } };
  const vfs = makeVfs();
  const sliceResults = [];
  const exportCalls = [];
  const workerBackend = {
    async readExports() {
      return {
        get_image_base: 0x400000, get_code_start: 0x401000, get_code_end: 0x500000,
        get_thunk_base: 0x700000, get_thunk_end: 0x710000, get_num_thunks: 100,
        get_dll_count: 3, get_vlan_local_ip: 0, get_tls_next_index: 7,
      };
    },
    async spawnThread(spec) {
      return {
        slot: 1,
        startEip: spec.startAddr >>> 0,
        startEsp: 0x100000,
        slice: async () => sliceResults.shift() || { yield: 0, eip: 0x4010 },
        callExport: async (name) => { exportCalls.push(name); },
      };
    },
  };
  const tm = new ThreadManager({}, memory, mainInstance, () => ({ host: {} }), {
    workerBackend,
    getVfs: () => vfs,
  });
  tm._log = () => {};
  tm._clearWorkerCacheSlot = () => {};

  tm.createThread(0x401100, 0, 0x10000, 0);
  await tm._spawnPendingWorkers();
  const [handle, thread] = Array.from(tm.threads.entries())[0];

  // The brokered ReadFile set pendingRead on the main thread, then the slice
  // came back parked on yield 12.
  const pending = { path: 'd:\\diabdat.mpq', handle: 0x30, pos: 0, offset: 0, length: 4096 };
  vfs.pendingRead = pending;
  sliceResults.push({ yield: 12, eip: 0x4010 });
  const run = tm._runWorkerThread(handle, thread, 1000, {});
  // The fill is awaited before clear_yield, so resolve it while the slice
  // handler is in flight.
  await Promise.resolve();
  vfs.finishFill();
  await run;

  assert.strictEqual(vfs.fills.length, 1, 'worker backend must run the chunk fill');
  assert.strictEqual(vfs.fills[0], pending, 'the fill must receive the parked read');
  assert.strictEqual(vfs.pendingRead, null, 'the pending slot must be consumed');
  assert.deepStrictEqual(exportCalls, ['clear_yield'],
    'the parked thread must be re-entered after the fill');
  assert.strictEqual(thread.state, 'active', 'the thread stays alive across the park');

  // A peer's read consumed the pending slot first: clearing without a fill is
  // still correct — the retry either hits or parks again with a fresh pending.
  sliceResults.push({ yield: 12, eip: 0x4010 });
  await tm._runWorkerThread(handle, thread, 1000, {});
  assert.strictEqual(vfs.fills.length, 1, 'no pending: nothing to fill');
  assert.deepStrictEqual(exportCalls, ['clear_yield', 'clear_yield'],
    'the thread must still be re-entered');

  console.log('  ok    worker backend fills the chunk and re-enters the parked ReadFile');
}

async function testCooperativeBackend() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const mainInstance = { exports: { get_sync_table: () => 0, get_bp_addr: () => 0, get_watch_addr: () => 0 } };
  const vfs = makeVfs();
  const tm = new ThreadManager({}, memory, mainInstance, () => ({ host: {} }), {
    getVfs: () => vfs,
  });
  tm._log = () => {};

  let yieldReason = 12;
  let clears = 0;
  let runs = 0;
  const exportsMock = {
    get_yield_reason: () => yieldReason,
    clear_yield: () => { clears++; yieldReason = 0; },
    get_eip: () => 0x4010,
    get_esp: () => 0x100000,
    get_current_thread_id: () => 2,
    run: () => { runs++; },
  };
  tm.threads.set(0xE1001, {
    instance: { exports: exportsMock },
    state: 'active', tid: 2, suspendCount: 0,
    sleepUntil: 0, sleepCount: 0, waitPolls: 0,
  });

  const pending = { path: 'd:\\diabdat.mpq', handle: 0x30, pos: 0, offset: 0, length: 4096 };
  vfs.pendingRead = pending;

  // Slice 1: the park starts the async fill and leaves the thread parked.
  tm.runSlice(1000, { quantumSteps: 1000 });
  assert.strictEqual(vfs.fills.length, 1, 'first slice must start the fill');
  assert.strictEqual(clears, 0, 'the thread stays parked while the fill is in flight');
  assert.strictEqual(runs, 0, 'a parked thread gets no steps');

  // Slice 2, fill still in flight: no second fill, still parked.
  tm.runSlice(1000, { quantumSteps: 1000 });
  assert.strictEqual(vfs.fills.length, 1, 'the fill must not be restarted');
  assert.strictEqual(clears, 0);

  // The fill lands on the event loop.
  vfs.finishFill();
  await new Promise(resolve => setImmediate(resolve));

  // Slice 3: the yield is cleared and the thread runs its slice.
  tm.runSlice(1000, { quantumSteps: 1000 });
  assert.strictEqual(clears, 1, 'the slice after the fill must clear the yield');
  assert.strictEqual(runs, 1, 'the re-entered thread must get its steps');
  assert.strictEqual(vfs.pendingRead, null);

  // Overwritten pending slot: yield 12 with nothing pending clears immediately.
  yieldReason = 12;
  tm.runSlice(1000, { quantumSteps: 1000 });
  assert.strictEqual(clears, 2, 'no pending: retry immediately');
  assert.strictEqual(vfs.fills.length, 1);

  console.log('  ok    cooperative backend parks across the async fill and re-enters');
}

(async () => {
  await testWorkerBackend();
  await testCooperativeBackend();
  console.log('PASS  spawned-thread io_wait is serviced by both scheduler backends');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
