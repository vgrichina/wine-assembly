#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ThreadManager } = require('../lib/thread-manager');

const handlersWat = fs.readFileSync(path.join(__dirname, '..', 'src', '09a-handlers.wat'), 'utf8');
const headerWat = fs.readFileSync(path.join(__dirname, '..', 'src', '01-header.wat'), 'utf8');
assert(!handlersWat.includes('(call $host_log_i32 (global.get $eax))'),
  'synchronization handlers must not cross to the host solely to print return values');
assert(headerWat.includes('(global $MAX_SYNC_OBJECTS i32 (i32.const 512))'),
  'the WAT synchronization table must match the host manager capacity');

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

const idTm = makeThreadManager();
const threadIdWa = 0x100;
const idView = new DataView(idTm.memory.buffer);
idView.setUint32(threadIdWa, 0xdeadbeef, true);
const idHandle = idTm.createThread(0x5000, 0, 0, 0, threadIdWa);
assert.strictEqual(idHandle, 0xE1000,
  'CreateThread still returns the independently allocated kernel handle');
assert.strictEqual(idView.getUint32(threadIdWa, true), 2,
  'lpThreadId receives the worker current_thread_id, not the kernel handle');
assert.notStrictEqual(idHandle, idView.getUint32(threadIdWa, true),
  'thread HANDLE and thread id remain distinct Win32 namespaces');

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

const selfSuspendTm = makeThreadManager();
const selfSuspendHandle = selfSuspendTm.createThread(0x6080, 0, 0, 0);
selfSuspendTm._runningThreadHandle = selfSuspendHandle;
assert.strictEqual(selfSuspendTm.suspendThread(selfSuspendHandle), 0x80000000,
  'a worker self-suspend privately tags the zero previous count for the WAT dispatcher');
assert.strictEqual(selfSuspendTm._pendingThreads[0].suspendCount, 1,
  'self-suspend increments exactly once before the guest slice yields');
selfSuspendTm._runningThreadHandle = 0;
assert.strictEqual(selfSuspendTm.resumeThread(selfSuspendHandle), 1,
  'another thread observes and releases the ordinary Win32 suspend count');
assert(handlersWat.includes('(global.set $yield_reason (i32.const 11))'),
  'SuspendThread self-calls park the current guest slice before it can suspend again');

const duplicateTm = makeThreadManager();
const duplicatedMainA = duplicateTm.duplicateCurrentThread(1);
const duplicatedMainB = duplicateTm.duplicateCurrentThread(1);
assert(duplicatedMainA && duplicatedMainB && duplicatedMainA !== duplicatedMainB,
  'each DuplicateHandle call returns a distinct real current-thread handle');
assert.notStrictEqual(duplicatedMainA >>> 0, 0xfffffffe,
  'a duplicated current-thread handle must not preserve the contextual pseudo handle');
assert.strictEqual(duplicateTm.suspendThread(duplicatedMainA), 0,
  'the first duplicated-handle suspend returns the previous main-thread count');
assert.strictEqual(duplicateTm.isMainThreadSuspended(), true,
  'a duplicated main-thread handle controls main scheduling state');
assert.strictEqual(duplicateTm.suspendThread(duplicatedMainB), 1,
  'duplicates share the underlying thread suspend count');
assert.strictEqual(duplicateTm.resumeThread(duplicatedMainA), 2);
assert.strictEqual(duplicateTm.resumeThread(duplicatedMainB), 1);
assert.strictEqual(duplicateTm.isMainThreadSuspended(), false);
assert.strictEqual(duplicateTm.getExitCodeThread(duplicatedMainA), 0x103,
  'GetExitCodeThread accepts duplicated main-thread handles');
assert.strictEqual(duplicateTm.closeSyncHandle(duplicatedMainA), true,
  'CloseHandle releases a duplicated thread-handle identity');
assert.strictEqual(duplicateTm.suspendThread(duplicatedMainA), 0xFFFFFFFF,
  'a closed duplicated thread handle is invalid');
assert.strictEqual(duplicateTm.suspendThread(duplicatedMainB), 0,
  'closing one duplicate leaves another handle to the same thread usable');
assert.strictEqual(duplicateTm.resumeThread(duplicatedMainB), 1);

duplicateTm.createThread(0x6200, 0, 0, 0);
const duplicatedWorker = duplicateTm.duplicateCurrentThread(2);
assert(duplicatedWorker, 'a worker can duplicate its own current-thread pseudo handle');
assert.strictEqual(duplicateTm.suspendThread(duplicatedWorker), 0,
  'the duplicated worker handle shares its pending thread suspend state');
assert.strictEqual(duplicateTm._pendingThreads[0].suspendCount, 1);
assert.strictEqual(duplicateTm.resumeThread(duplicatedWorker), 1);

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
assert.strictEqual(
  pendingWaitTm.terminateThread(pendingWaitHandle, 0x2a),
  1,
  'TerminateThread reports success for a known worker handle'
);
assert.strictEqual(
  pendingWaitTm.getExitCodeThread(pendingWaitHandle),
  0x2a,
  'TerminateThread stores the requested exit code'
);
assert.strictEqual(
  pendingWaitTm.terminateThread(0xdeadbeef, 7),
  1,
  'TerminateThread treats stale installer helper handles as successful no-ops'
);

const currentProcessTm = makeThreadManager();
assert.strictEqual(currentProcessTm.waitSingle(0x000E23E8, 0), 0x102,
  'a zero-time wait reports the current process handle as still active');
assert.strictEqual(currentProcessTm.waitSingle(0x000E23E8, 0xFFFFFFFF), 0xFFFF,
  'an infinite current-process wait parks for cooperative scheduling');

const syncLifecycleTm = makeThreadManager();
const syncHandles = [];
for (let i = 0; i < 512; i++) {
  syncHandles.push(syncLifecycleTm.createEvent(false, false));
}
assert(syncHandles.every(Boolean),
  'all 512 synchronization slots should allocate, leaving room beyond Diablo II\'s startup event pool');
assert.strictEqual(syncLifecycleTm.createEvent(false, false), 0, 'the full synchronization table rejects another event');
assert.strictEqual(syncLifecycleTm.closeSyncHandle(syncHandles[17]), true, 'CloseHandle should release an event slot');
const staleEvent = syncHandles[17];
const replacementEvent = syncLifecycleTm.createEvent(true, true);
assert.strictEqual(
  syncLifecycleTm._getSyncIdx(replacementEvent),
  17,
  'the next event should reuse the released table slot with a new identity'
);
assert.strictEqual(
  Atomics.load(syncLifecycleTm.syncView, 17 * 4) >>> 0,
  replacementEvent >>> 0,
  'the shared synchronization slot mirrors the exact current event handle'
);
assert.notStrictEqual(replacementEvent, staleEvent,
  'a recycled synchronization slot must advance its handle generation');
assert.strictEqual(syncLifecycleTm.closeSyncHandle(staleEvent), false,
  'a stale CloseHandle must not close the replacement event');
syncLifecycleTm.resetEvent(replacementEvent);
syncLifecycleTm.setEvent(staleEvent);
assert.strictEqual(syncLifecycleTm.waitSingle(replacementEvent, 0), 0x102,
  'a delayed SetEvent for the old generation must not signal the replacement');
const issuedEventHandles = new Set([staleEvent, replacementEvent]);
let churnedEvent = replacementEvent;
for (let i = 0; i < 128; i++) {
  assert.strictEqual(syncLifecycleTm.closeSyncHandle(churnedEvent), true);
  churnedEvent = syncLifecycleTm.createEvent(false, false);
  assert.strictEqual(syncLifecycleTm._getSyncIdx(churnedEvent), 17);
  assert(!issuedEventHandles.has(churnedEvent),
    'rapid synchronization churn must not wrap back to an earlier handle identity');
  issuedEventHandles.add(churnedEvent);
}
assert.strictEqual(syncLifecycleTm.closeSyncHandle(0xdeadbeef), false, 'an unrelated handle is not a synchronization object');
assert.strictEqual(syncLifecycleTm.closeSyncHandle(syncHandles[18]), true, 'semaphore test should begin with a free slot');
const reusedSemaphore = syncLifecycleTm.createSemaphore(2, 4);
assert.strictEqual(syncLifecycleTm._getSyncIdx(reusedSemaphore), 18,
  'semaphores should share and reuse synchronization slots with a new identity');
assert.strictEqual(Atomics.load(syncLifecycleTm.syncView, 18 * 4) >>> 0, reusedSemaphore >>> 0,
  'the shared synchronization slot mirrors the exact current semaphore handle');
assert.notStrictEqual(reusedSemaphore, syncHandles[18],
  'a recycled semaphore slot must also advance its handle generation');
assert.strictEqual(syncLifecycleTm.closeSyncHandle(reusedSemaphore), true, 'CloseHandle should release a semaphore slot');

const namedEventTm = makeThreadManager();
assert.strictEqual(namedEventTm.openEvent('StarcraftSetupEvent'), 0,
  'OpenEvent reports a missing process-local name');
const namedEvent = namedEventTm.createEvent(false, false, 'StarcraftSetupEvent');
assert(namedEvent, 'CreateEvent allocates a named event');
assert.strictEqual(namedEventTm.openEvent('starcraftsetupevent'), 0,
  'named kernel objects use case-sensitive names');
assert.strictEqual(namedEventTm.openEvent('StarcraftSetupEvent'), namedEvent,
  'OpenEvent finds the existing named event');
assert.strictEqual(namedEventTm.createEvent(true, true, 'StarcraftSetupEvent'), namedEvent,
  'CreateEvent returns the existing object when its name already exists');
assert.strictEqual(namedEventTm.closeSyncHandle(namedEvent), true,
  'closing one named-event reference succeeds');
assert.strictEqual(namedEventTm.openEvent('StarcraftSetupEvent'), namedEvent,
  'the named object survives while other references remain');
assert.strictEqual(namedEventTm.closeSyncHandle(namedEvent), true);
assert.strictEqual(namedEventTm.closeSyncHandle(namedEvent), true);
assert.strictEqual(namedEventTm.closeSyncHandle(namedEvent), true);
assert.strictEqual(namedEventTm.openEvent('StarcraftSetupEvent'), 0,
  'the name disappears after the final reference closes');

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
  Atomics.load(waitAllTm.syncView, waitAllTm._getSyncIdx(waitAllA) * 4 + 2),
  1,
  'an incomplete wait-all must not consume an already-signaled auto-reset event'
);
waitAllTm.setEvent(waitAllB);
assert.strictEqual(
  waitAllTm.waitMultiple(2, waitAllHandlesWA, true, 0),
  0,
  'wait-all completes once every object is signaled'
);
assert.strictEqual(Atomics.load(waitAllTm.syncView, waitAllTm._getSyncIdx(waitAllA) * 4 + 2), 0);
assert.strictEqual(Atomics.load(waitAllTm.syncView, waitAllTm._getSyncIdx(waitAllB) * 4 + 2), 0);

const inputDuringWaitAllTm = makeThreadManager({ hasMessage: () => true });
const inputDuringWaitAllEvent = inputDuringWaitAllTm.createEvent(false, false);
const inputDuringWaitAllHandlesWA = 0x1c0;
new Int32Array(inputDuringWaitAllTm.memory.buffer)[inputDuringWaitAllHandlesWA >>> 2] = inputDuringWaitAllEvent;
let inputDuringWaitAllCompleted = false;
inputDuringWaitAllTm.mainInstance.exports = {
  get_yield_reason: () => 1,
  get_wait_handle: () => 1,
  get_wait_handles_ptr: () => inputDuringWaitAllHandlesWA,
  get_wait_all: () => 1,
  get_wait_timeout: () => 0xFFFFFFFF,
  get_wait_stack_bytes: () => 20,
  get_esp: () => 0x200,
  guest_read32: () => 0x401234,
  clear_yield: () => { inputDuringWaitAllCompleted = true; },
  set_eax: () => {},
  set_esp: () => {},
  set_eip: () => {},
};
assert.strictEqual(
  inputDuringWaitAllTm.checkMainYield(),
  true,
  'queued browser input must not satisfy an ordinary WaitForMultipleObjects'
);
assert.strictEqual(inputDuringWaitAllCompleted, false,
  'ordinary multi-object waits remain parked until their synchronization objects are ready');

function completeMainEventWait(traceThread) {
  const waitTm = makeThreadManager({ traceThread });
  const waitEvent = waitTm.createEvent(false, true);
  const emitted = [];
  let esp = 0x100;
  waitTm._log = line => emitted.push(line);
  waitTm.mainInstance.exports = {
    get_yield_reason: () => 1,
    get_wait_handle: () => waitEvent,
    get_wait_handles_ptr: () => 0,
    get_wait_all: () => 0,
    get_wait_timeout: () => 0xFFFFFFFF,
    get_wait_stack_bytes: () => 12,
    get_esp: () => esp,
    guest_read32: addr => addr === esp ? 0x401234 : 0,
    clear_yield: () => {},
    set_eax: () => {},
    set_esp: value => { esp = value >>> 0; },
    set_eip: () => {},
  };
  assert.strictEqual(waitTm.checkMainYield(), false, 'a signaled main-thread wait completes');
  return emitted;
}

assert.deepStrictEqual(
  completeMainEventWait(false),
  [],
  'ordinary main-thread wait completions must not emit console diagnostics'
);
assert.strictEqual(
  completeMainEventWait(true).length,
  1,
  'thread tracing retains the main-thread wait completion diagnostic'
);

let mainSleepNow = 100;
let mainSleepPending = 1;
const mainSleepTm = makeThreadManager({ now: () => mainSleepNow });
mainSleepTm.mainInstance.exports = {
  get_sleep_yielded: () => {
    const pending = mainSleepPending;
    mainSleepPending = 0;
    return pending;
  },
  get_sleep_timeout: () => 10,
  get_yield_reason: () => 0,
};
assert.strictEqual(mainSleepTm.checkMainYield(), true,
  'main-thread Sleep parks the main instance until its wall-clock deadline');
assert.strictEqual(mainSleepTm._mainSleepUntil, 110);
mainSleepNow = 109;
assert.strictEqual(mainSleepTm.checkMainYield(), true,
  'main-thread Sleep remains parked before the full timeout elapses');
mainSleepNow = 110;
assert.strictEqual(mainSleepTm.checkMainYield(), false,
  'main-thread Sleep resumes when the full timeout has elapsed');
assert.strictEqual(mainSleepTm._mainSleepUntil, 0);

function createSyncObjects(traceThread) {
  const syncTm = makeThreadManager({ traceThread });
  const emitted = [];
  syncTm._log = line => emitted.push(line);
  const event = syncTm.createEvent(false, false);
  syncTm.setEvent(event);
  syncTm.createSemaphore(0, 1);
  return emitted;
}

assert.deepStrictEqual(
  createSyncObjects(false),
  [],
  'ordinary synchronization-object creation must not emit console diagnostics'
);
assert.strictEqual(
  createSyncObjects(true).length,
  3,
  'thread tracing retains synchronization-object and signal diagnostics'
);

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

// The host-side block-cache-index clear is GONE, deliberately. It zeroed
// `0x07152000 + tid * 0x8000` — a hand-copied literal of the retired
// CACHE_INDEX region, an address the region allocator now hands to
// $PE_STAGING, so the clear had turned into a 32KB scribble on the PE staging
// arena at every worker spawn. `init_thread` does the real per-slot
// invalidation in WAT. This asserts nobody puts it back.
const cacheTm = makeThreadManagerWithMemory(
  new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true }));
assert.strictEqual(typeof cacheTm._clearWorkerCacheSlot, 'undefined',
  'host must not clear worker cache slots by address; init_thread does it in WAT');

function makeRunnableThread(tid, onRun) {
  let heapPtr = 0;
  let freeList = 0;
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
        set_free_list: v => { freeList = v >>> 0; },
        get_free_list: () => freeList,
        run: onRun,
        get_bp_addr: () => 0,
        get_sleep_yielded: () => 0,
      },
    },
  };
}

// The free-list head is no longer marshalled between instances around a slice.
// That only ever worked because exactly one instance ran at a time and JS got a
// turn in between — neither holds with real threads. Each instance now carves a
// private arena from a shared-memory cursor ($heap_low_reserve), so there is no
// per-slice hand-off left to assert. Cross-instance disjointness is covered by
// test-virtual-map-cross-instance.js.

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

// The browser's isolated-Worker main thread uses resolveMainWorkerWait rather
// than checkMainYield. Keep a short guest-clock timeout from winning after only
// one worker slice while another runnable guest thread can still signal it.
// Storm uses this exact 255ms shape for MPQ decompression completion; returning
// WAIT_TIMEOUT here lets it consume a partial buffer and D2CMP fails later.
let workerWaitNow = 1000;
const workerWaitTm = makeThreadManager({ now: () => workerWaitNow });
const workerWaitEvent = workerWaitTm.createEvent(0, 0);
workerWaitTm.threads.set(0xe1013, makeRunnableThread(1, () => {}));
const workerWait = {
  waitHandle: workerWaitEvent,
  waitHandlesPtr: 0,
  waitAll: false,
  waitTimeout: 255,
  waitStackBytes: 12,
};
assert.strictEqual(workerWaitTm.resolveMainWorkerWait(workerWait), null,
  'isolated main wait parks while its worker is still runnable');
workerWaitNow += 1000;
assert.strictEqual(workerWaitTm.resolveMainWorkerWait(workerWait), null,
  'guest-clock expiry alone must not truncate runnable Worker work');
workerWaitTm.setEvent(workerWaitEvent);
assert.deepStrictEqual(workerWaitTm.resolveMainWorkerWait(workerWait), {
  result: 0,
  waitStackBytes: 12,
}, 'isolated main wait completes as soon as its worker signals');

let cappedWaitNow = 1000;
const cappedWaitTm = makeThreadManager({ now: () => cappedWaitNow });
const cappedWaitEvent = cappedWaitTm.createEvent(0, 0);
cappedWaitTm.threads.set(0xe1014, makeRunnableThread(1, () => {}));
const cappedWait = { ...workerWait, waitHandle: cappedWaitEvent };
assert.strictEqual(cappedWaitTm.resolveMainWorkerWait(cappedWait), null);
cappedWaitNow += 1000;
for (let poll = 1; poll < 255; poll++) {
  assert.strictEqual(cappedWaitTm.resolveMainWorkerWait(cappedWait), null,
    `isolated bounded wait must remain parked through poll ${poll}`);
}
assert.deepStrictEqual(cappedWaitTm.resolveMainWorkerWait(cappedWait), {
  result: 0x102,
  waitStackBytes: 12,
}, 'an unsignalled isolated bounded wait still times out at its poll ceiling');

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

// A worker's hwnds have to come out of its own app's slice. They used to be
// derived from the thread id alone (0x10001 + tid * 0x10000), which put every
// worker window outside the range the shell prunes when that app stops -- so a
// window a worker had put up survived its guest forever, and the repaint after
// the stop handed the display back to a dead app. Whether it happened at all
// depended on whether the app ever created a window off a worker thread, which
// is exactly the "sometimes works, sometimes doesn't" shape. The second app's
// range also collided with the first app's T1 outright.
for (const appBase of [0x10001, 0x20001, 0x70001]) {
  const scoped = makeThreadManager({ hwndBase: () => appBase });
  const seen = new Set();
  for (let tid = 1; tid <= scoped._maxWorkerThreads; tid++) {
    const base = scoped.workerHwndBase(tid);
    assert(base > appBase && base < appBase + 0x10000,
      `worker ${tid} of the app at ${appBase.toString(16)} must stay inside its own slice, got ${base.toString(16)}`);
    assert(!seen.has(base), `worker ${tid} must not share a base with another worker`);
    seen.add(base);
  }
  // Main gets the whole bottom half, so a lifetime of dialogs and controls
  // cannot walk into T1's numbers.
  assert.strictEqual(scoped.workerHwndBase(1) - appBase, 0x8000,
    'the main thread keeps the bottom half of the slice');
}
// Defaulting matters too: the CLI host constructs the manager with no base.
assert.strictEqual(makeThreadManager().workerHwndBase(1), 0x10001 + 0x8000,
  'with no app base the manager still lands inside the first app slice');

console.log('PASS  ThreadManager reuses exited worker cache slots');
console.log('PASS  ThreadManager schedules, suspends and resumes worker slices');
console.log('PASS  ThreadManager supports wall-budgeted worker slices');
console.log('PASS  ThreadManager prioritizes hot audio threads');
console.log('PASS  ThreadManager notifies thread exits once');
console.log('PASS  ThreadManager completes nested infinite waits without losing callback state');
console.log('PASS  ThreadManager keeps pending worker handles unsignaled');
console.log('PASS  ThreadManager recycles closed event and semaphore handles');
console.log('PASS  ThreadManager preserves and atomically consumes wait-all state');
console.log('PASS  ThreadManager keeps main wait completion logs trace-only');
console.log('PASS  ThreadManager keeps synchronization-object creation logs trace-only');
console.log('PASS  ThreadManager keeps every worker hwnd inside its own app slice');
