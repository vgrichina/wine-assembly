#!/usr/bin/env node
const assert = require('assert');
const { ThreadManager } = require('../lib/thread-manager');

function makeThreadManager() {
  return makeThreadManagerWithMemory(new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }));
}

function makeThreadManagerWithMemory(memory) {
  const mainInstance = {
    exports: {
      get_sync_table: () => 0,
      get_heap_ptr: () => 0,
      set_heap_ptr: () => {},
    },
  };
  const tm = new ThreadManager({}, memory, mainInstance, () => ({ host: {} }), {});
  tm._log = () => {};
  return tm;
}

const tm = makeThreadManager();
const handles = [];

for (let i = 0; i < 7; i++) {
  const handle = tm.createThread(0x1000 + i, 0, 0);
  assert(handle, `worker slot ${i + 1} should allocate`);
  handles.push(handle);
}

assert.strictEqual(tm.createThread(0x2000, 0, 0), 0, 'all pending slots should block another worker');
assert.deepStrictEqual(tm._pendingThreads.map(p => p.tid), [1, 2, 3, 4, 5, 6, 7]);

for (const pending of tm._pendingThreads) {
  tm.threads.set(pending.handle, { tid: pending.tid, state: 'active' });
}
tm._pendingThreads = [];

assert.strictEqual(tm.createThread(0x3000, 0, 0), 0, 'all active slots should block another worker');

tm.threads.get(handles[0]).state = 'exited';
const reused = tm.createThread(0x4000, 0, 0);
assert(reused, 'an exited worker slot should be reusable');
assert.strictEqual(tm._pendingThreads[0].tid, 1, 'the first exited slot should be reused');
assert(!tm.threads.has(handles[0]), 'reused exited slot should drop old handle bookkeeping');

assert.strictEqual(tm.createThread(0x5000, 0, 0), 0, 'a pending reused slot still counts as occupied');

const fullMemory = new WebAssembly.Memory({ initial: 2048, maximum: 2048, shared: true });
const cacheTm = makeThreadManagerWithMemory(fullMemory);
const worker1CacheIndex = 0x05E52000 + 0x8000;
const cacheBytes = new Uint8Array(fullMemory.buffer, worker1CacheIndex, 0x8000);
cacheBytes.fill(0x7f);
cacheTm._clearWorkerCacheSlot(1);
assert(cacheBytes.every(byte => byte === 0), 'reused worker slot should clear its decoded-block index');

function makeRunnableThread(tid, onRun) {
  let heapPtr = 0;
  return {
    tid,
    state: 'active',
    sleepCount: 0,
    sleepUntil: 0,
    waitPolls: 0,
    waitStartedAt: 0,
    instance: {
      exports: {
        get_yield_reason: () => 0,
        get_eip: () => 0x401000,
        set_heap_ptr: v => { heapPtr = v >>> 0; },
        get_heap_ptr: () => heapPtr,
        run: onRun,
        get_bp_addr: () => 0,
        get_sleep_yielded: () => 0,
      },
    },
  };
}

let now = 0;
const budgetTm = makeThreadManager();
budgetTm._now = () => now;
let budgetRuns = 0;
budgetTm.threads.set(0xe1000, makeRunnableThread(1, steps => {
  assert.strictEqual(steps, 100, 'budgeted scheduler should run the configured quantum');
  budgetRuns++;
  now += 3;
}));
const budgetStats = budgetTm.runBudgeted({ quantumSteps: 100, maxTotalSteps: 1000, maxWallMs: 5 });
assert.strictEqual(budgetRuns, 2, 'budgeted scheduler should stop after crossing the wall-clock budget');
assert.strictEqual(budgetStats.hitDeadline, true, 'budgeted scheduler should report deadline stops');
assert.strictEqual(budgetStats.steps, 200, 'budgeted scheduler should report approximate executed steps');

const messageTm = makeThreadManager();
messageTm._hasMessage = () => true;
let messageRuns = 0;
messageTm.threads.set(0xe1000, makeRunnableThread(1, () => { messageRuns++; }));
const messageStats = messageTm.runBudgeted({ quantumSteps: 100, maxTotalSteps: 1000, maxWallMs: 5, stopIfMessagePending: true });
assert.strictEqual(messageRuns, 0, 'budgeted scheduler should not run workers when main messages are pending');
assert.strictEqual(messageStats.stoppedForMessage, true, 'budgeted scheduler should report message stops');

console.log('PASS  ThreadManager reuses exited worker cache slots');
console.log('PASS  ThreadManager supports wall-budgeted worker slices');
