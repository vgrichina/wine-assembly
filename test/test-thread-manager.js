#!/usr/bin/env node
const assert = require('assert');
const { ThreadManager } = require('../lib/thread-manager');

function makeThreadManager(opts) {
  return makeThreadManagerWithMemory(new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }), opts);
}

function makeThreadManagerWithMemory(memory, opts) {
  const mainInstance = {
    exports: {
      get_sync_table: () => 0,
      get_heap_ptr: () => 0,
      set_heap_ptr: () => {},
    },
  };
  const tm = new ThreadManager({}, memory, mainInstance, () => ({ host: {} }), opts || {});
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

const suspendTm = makeThreadManager({ recordThreadEvents: true });
const suspendedHandle = suspendTm.createThread(0x6000, 0, 0, 0x4);
assert.strictEqual(suspendTm._pendingThreads[0].suspendCount, 1, 'CREATE_SUSPENDED is atomic with thread creation');
assert.strictEqual(suspendTm.suspendThread(suspendedHandle), 1, 'nested suspend returns the previous count');
assert.strictEqual(suspendTm._pendingThreads[0].suspendCount, 2, 'pending CREATE_SUSPENDED state survives until instantiation');
assert.strictEqual(suspendTm.resumeThread(suspendedHandle), 2, 'first resume returns two and leaves the thread suspended');
assert.strictEqual(suspendTm.resumeThread(suspendedHandle), 1, 'final resume returns one and makes the thread runnable');
assert.strictEqual(suspendTm.resumeThread(suspendedHandle), 0, 'resuming a running thread returns zero without underflow');
assert.strictEqual(suspendTm.suspendThread(0xdeadbeef), 0xFFFFFFFF, 'invalid suspend handle fails');
assert.strictEqual(suspendTm.resumeThread(0xdeadbeef), 0xFFFFFFFF, 'invalid resume handle fails');

const pendingWaitTm = makeThreadManager();
const pendingWaitHandle = pendingWaitTm.createThread(0x6100, 0, 0, 0x4);
const pendingWaitEvent = pendingWaitTm.createEvent(false, false);
const pendingWaitHandlesWA = 0x100;
const pendingWaitMemory = new Int32Array(pendingWaitTm.memory.buffer);
pendingWaitMemory[pendingWaitHandlesWA >>> 2] = pendingWaitEvent;
pendingWaitMemory[(pendingWaitHandlesWA >>> 2) + 1] = pendingWaitHandle;
assert.strictEqual(
  pendingWaitTm.waitSingle(pendingWaitHandle, 0),
  0xFFFF,
  'a thread handle remains unsignaled while its worker instance is pending'
);
assert.strictEqual(
  pendingWaitTm.waitMultiple(2, pendingWaitHandlesWA, false, 0),
  0x102,
  'WaitForMultipleObjects must not report a pending thread as exited'
);
assert.strictEqual(
  pendingWaitTm.getExitCodeThread(pendingWaitHandle),
  0x103,
  'GetExitCodeThread reports a pending worker as STILL_ACTIVE'
);

const syncLifecycleTm = makeThreadManager();
const syncHandles = [];
for (let i = 0; i < 64; i++) {
  syncHandles.push(syncLifecycleTm.createEvent(false, false));
}
assert(syncHandles.every(Boolean), 'all 64 synchronization slots should allocate');
assert.strictEqual(syncLifecycleTm.createEvent(false, false), 0, 'the full synchronization table rejects another event');
assert.strictEqual(syncLifecycleTm.closeSyncHandle(syncHandles[17]), true, 'CloseHandle should release an event slot');
assert.strictEqual(
  syncLifecycleTm.createEvent(true, true),
  syncHandles[17],
  'the next event should reuse the released table slot'
);
assert.strictEqual(syncLifecycleTm.closeSyncHandle(0xdeadbeef), false, 'an unrelated handle is not a synchronization object');
assert.strictEqual(syncLifecycleTm.closeSyncHandle(syncHandles[18]), true, 'semaphore test should begin with a free slot');
const reusedSemaphore = syncLifecycleTm.createSemaphore(2, 4);
assert.strictEqual(reusedSemaphore, syncHandles[18], 'semaphores should share and reuse the synchronization table');
assert.strictEqual(syncLifecycleTm.closeSyncHandle(reusedSemaphore), true, 'CloseHandle should release a semaphore slot');

const waitAllTm = makeThreadManager();
const waitAllA = waitAllTm.createEvent(false, false);
const waitAllB = waitAllTm.createEvent(false, false);
const waitAllHandlesWA = 0x180;
const waitAllMemory = new Int32Array(waitAllTm.memory.buffer);
waitAllMemory[waitAllHandlesWA >>> 2] = waitAllA;
waitAllMemory[(waitAllHandlesWA >>> 2) + 1] = waitAllB;
waitAllTm.setEvent(waitAllA);
assert.strictEqual(
  waitAllTm.waitMultiple(2, waitAllHandlesWA, true, 0),
  0x102,
  'wait-all remains blocked while only one object is signaled'
);
assert.strictEqual(
  Atomics.load(waitAllTm.syncView, (waitAllA - 0xE0000) * 4 + 2),
  1,
  'an incomplete wait-all must not consume an already-signaled auto-reset event'
);
waitAllTm.setEvent(waitAllB);
assert.strictEqual(
  waitAllTm.waitMultiple(2, waitAllHandlesWA, true, 0),
  0,
  'wait-all completes once every object is signaled'
);
assert.strictEqual(Atomics.load(waitAllTm.syncView, (waitAllA - 0xE0000) * 4 + 2), 0);
assert.strictEqual(Atomics.load(waitAllTm.syncView, (waitAllB - 0xE0000) * 4 + 2), 0);

const lifecycleEvents = suspendTm.getThreadEvents();
assert.deepStrictEqual(
  lifecycleEvents.map(event => event.type),
  ['create', 'suspend', 'resume', 'resume', 'resume'],
  'thread lifecycle events preserve creation and suspend/resume order'
);
assert.strictEqual(lifecycleEvents[0].creationFlags, 0x4, 'create event preserves dwCreationFlags');
assert.strictEqual(lifecycleEvents[0].suspendCount, 1, 'create event records the initial suspend count');
assert.strictEqual(lifecycleEvents[2].previousSuspendCount, 2, 'resume event records the previous count');
assert.strictEqual(lifecycleEvents[3].suspendCount, 0, 'final resume event records runnable state');

const fullMemory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
const cacheTm = makeThreadManagerWithMemory(fullMemory);
const worker1CacheIndex = 0x07152000 + 0x8000;
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

const suspendedRunTm = makeThreadManager();
let suspendedRuns = 0;
const suspendedRunnable = makeRunnableThread(1, () => { suspendedRuns++; });
suspendedRunnable.suspendCount = 1;
suspendedRunTm.threads.set(0xe1010, suspendedRunnable);
assert.strictEqual(suspendedRunTm.hasActiveThreads(), false, 'a suspended worker is not runnable');
suspendedRunTm.runSlice(100);
assert.strictEqual(suspendedRuns, 0, 'scheduler does not execute a suspended worker');
assert.strictEqual(suspendedRunTm.resumeThread(0xe1010), 1, 'resuming an instantiated worker returns its previous count');
assert.strictEqual(suspendedRunTm.hasActiveThreads(), true, 'the final resume makes the worker runnable');
suspendedRunTm.runSlice(100);
assert.strictEqual(suspendedRuns, 1, 'scheduler executes the worker after its final resume');

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

const priorityTm = makeThreadManager();
priorityTm._now = () => now;
now = 0;
const priorityRuns = [];
priorityTm.threads.set(0xe1000, makeRunnableThread(1, () => {
  priorityRuns.push('visualizer');
  now += 10;
}));
priorityTm.threads.set(0xe1001, makeRunnableThread(4, () => {
  priorityRuns.push('audio');
}));
priorityTm.markAudioThread(4, 1000);
priorityTm.runBudgeted({
  quantumSteps: 100,
  maxTotalSteps: 1000,
  maxWallMs: 5,
  prioritizeAudioThreads: true,
});
assert.strictEqual(priorityRuns[0], 'audio', 'budgeted scheduler should run hot audio threads before visual workers');
priorityRuns.length = 0;
priorityTm.runBudgeted({
  quantumSteps: 100,
  maxTotalSteps: 1000,
  maxWallMs: 5,
  prioritizeAudioThreads: true,
});
assert.strictEqual(priorityRuns[0], 'visualizer', 'budgeted scheduler should alternate priority so hot audio cannot starve visual workers');

const exitNotifications = [];
const exitTm = makeThreadManager({
  onThreadExit: info => exitNotifications.push(info),
});
exitTm.markAudioThread(3, 1000);
const exitThread = { tid: 3, state: 'active', startAddr: 0x440330, param: 0x458060 };
exitTm.threads.set(0xe1007, exitThread);
exitTm._markThreadExited(0xe1007, exitThread, 7, 'test');
exitTm._markThreadExited(0xe1007, exitThread, 8, 'duplicate');
assert.strictEqual(exitNotifications.length, 1, 'thread exit callback should fire once');
assert.deepStrictEqual(exitNotifications[0], {
  handle: 0xe1007,
  tid: 3,
  startAddr: 0x440330,
  param: 0x458060,
  exitCode: 7,
  reason: 'test',
});
assert.strictEqual(exitTm._audioThreadHotUntil.has(3), false, 'exited audio-marked threads should be removed from hot priority');

const cooperativeTm = makeThreadManager();
const cooperativeHandle = 0xe1010;
let cooperativeRuns = 0;
const cooperativeThread = makeRunnableThread(1, () => {
  cooperativeRuns++;
  cooperativeTm._markThreadExited(cooperativeHandle, cooperativeThread, 0, 'cooperative wait test');
});
cooperativeThread.sleepUntil = Date.now() + 10000;
cooperativeThread.sleepCount = 4;
cooperativeTm.threads.set(cooperativeHandle, cooperativeThread);
assert.strictEqual(
  cooperativeTm.waitSingleCooperative(cooperativeHandle, 0xFFFFFFFF),
  0,
  'nested infinite wait should synchronously observe worker exit'
);
assert.strictEqual(cooperativeRuns, 1, 'nested infinite wait should wake and run its sleeping target worker');
assert.strictEqual(cooperativeThread.sleepUntil, 0, 'nested infinite wait should clear the target sleep gate');

const finiteWaitTm = makeThreadManager();
let finiteRuns = 0;
finiteWaitTm.threads.set(0xe1011, makeRunnableThread(1, () => { finiteRuns++; }));
assert.strictEqual(
  finiteWaitTm.waitSingleCooperative(0xe1011, 10),
  0xFFFF,
  'finite waits should retain normal cooperative scheduler semantics'
);
assert.strictEqual(finiteRuns, 0, 'finite waits should not synchronously pump workers');

const reentrantWaitTm = makeThreadManager();
let reentrantRuns = 0;
reentrantWaitTm.threads.set(0xe1012, makeRunnableThread(1, () => { reentrantRuns++; }));
reentrantWaitTm._runningThreadHandle = 0xe1012;
assert.strictEqual(
  reentrantWaitTm.waitSingleCooperative(0xe1012, 0xFFFFFFFF),
  0xFFFFFFFF,
  'nested wait should fail instead of recursively entering an active worker instance'
);
assert.strictEqual(reentrantRuns, 0, 'reentrant nested wait should not run the worker again');

console.log('PASS  ThreadManager reuses exited worker cache slots');
console.log('PASS  ThreadManager supports wall-budgeted worker slices');
console.log('PASS  ThreadManager prioritizes hot audio threads');
console.log('PASS  ThreadManager notifies thread exits once');
console.log('PASS  ThreadManager completes nested infinite waits without losing callback state');
console.log('PASS  ThreadManager keeps pending worker handles unsignaled');
console.log('PASS  ThreadManager recycles closed event and semaphore handles');
console.log('PASS  ThreadManager preserves and atomically consumes wait-all state');
