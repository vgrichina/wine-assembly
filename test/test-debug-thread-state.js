#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createDebugThreadState,
  createDeadlockWatchdog,
  collectSnapshot,
  formatSnapshot,
} = require('../lib/debug-thread-state');

const ROOT = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function fakeExports(state) {
  return {
    get_current_thread_id: () => state.tid,
    get_eip: () => state.eip,
    get_dbg_prev_eip: () => state.previousEip || 0,
    get_esp: () => state.esp,
    get_edx: () => state.edx || 0,
    get_yield_reason: () => state.yield,
    get_wait_handle: () => state.wait || 0,
    guest_read32: address => state.memory[address >>> 0] || 0,
    guest_read8: address => state.bytes && state.bytes[address >>> 0] || 0,
    get_dll_count: () => state.dllCount || 0,
    get_dll_table: () => state.dllTable || 0,
  };
}

const cs = 0x00444000;
const mainExports = fakeExports({
  tid: 1, eip: 0x07502A80, esp: 0x003FF000, yield: 9, wait: cs,
  memory: { [cs + 4]: 0, [cs + 8]: 1, [cs + 12]: 2 },
});
const workerExports = fakeExports({
  tid: 2, eip: 0x00412000, esp: 0x003EF000, yield: 1, wait: 0x10001,
  memory: {},
});
const wine = {
  running: true,
  instance: { exports: mainExports },
  threadManager: {
    threads: new Map([[0x1001, {
      tid: 1, state: 'active', suspendCount: 0, waitPolls: 7,
      instance: { exports: workerExports },
    }]]),
  },
};

const snapshot = collectSnapshot([{ wine, name: 'diablo_demo', appIndex: 0 }]);
assert.strictEqual(snapshot.apps[0].main.yieldName, 'critical section');
assert.deepStrictEqual(snapshot.apps[0].criticalSection, {
  address: cs, lockCount: 0, recursion: 1, owner: 2,
});
assert.strictEqual(snapshot.apps[0].workers[0].ownsBlockedSection, true,
  'the popup should identify the worker owning the main thread\'s blocked section');
assert.strictEqual(snapshot.apps[0].workers[0].slot, 1,
  'the worker cache/scheduler slot should remain visible');
assert.strictEqual(snapshot.apps[0].workers[0].tid, 2,
  'critical-section ownership should use the worker WAT guest thread id');
const text = formatSnapshot(snapshot);
assert(text.includes('yield=9 (critical section)'));
assert(text.includes('owner=T2'));
assert(text.includes('OWNS BLOCKED SECTION'));
assert(text.includes('S1/T2'));
assert(text.includes('scheduler=blocked:critical section'));

let now = 1000;
let storage = new Map([['reg:hklm\\software\\blizzard entertainment\\archives', '{"old":1}']]);
const watchdog = createDeadlockWatchdog({
  now: () => now,
  getStorageSnapshot: () => new Map(storage),
});
watchdog.beginLaunch('diablo_demo');
storage.set('reg:hklm\\software\\blizzard entertainment\\archives', '{"new":12345}');
let watched;
for (let i = 0; i < 4; i++) {
  watched = watchdog.enrich(collectSnapshot([{ wine, name: 'diablo_demo', appIndex: 0 }]));
  now += 500;
}
assert.strictEqual(watched.apps[0].deadlockWatch.samples, 4);
assert.strictEqual(watched.apps[0].deadlockWatch.ownerTid, 2);
assert.strictEqual(watched.apps[0].deadlockWatch.ownerHistory.length, 4);
assert(watched.apps[0].deadlockWatch.diagnosis.includes('owner EIP unchanged'));
assert.deepStrictEqual(watched.apps[0].storageChanges, [{
  key: 'reg:hklm\\software\\blizzard entertainment\\archives',
  kind: 'changed', beforeBytes: 9, afterBytes: 13,
}]);
const watchedText = formatSnapshot(watched);
assert(watchedText.includes('owner recent EIP<-previous'));
assert(watchedText.includes('localStorage changes since launch:'));
assert(watchedText.includes('reg:hklm\\software\\blizzard entertainment\\archives'));

// Name a loaded Storm module from DLL_TABLE and detect a cycle in the exact
// active list traversed while Storm holds its critical section.
const dllTable = 0x100;
const stormBase = 0x00632000;
const exportRva = 0x1000;
const nameRva = 0x1800;
const queueHead = stormBase + 0x22260;
const nodeA = 0x3FC00CD0;
const nodeB = 0x3FC00F50;
const dllMemory = new ArrayBuffer(0x400);
const dllView = new DataView(dllMemory);
dllView.setUint32(dllTable, stormBase, true);
dllView.setUint32(dllTable + 4, 0x30000, true);
dllView.setUint32(dllTable + 8, exportRva, true);
const stormState = {
  tid: 1, eip: 0x07502A88, esp: 0x003FF000, yield: 9, wait: cs,
  dllCount: 1, dllTable,
  memory: {
    [cs + 4]: 0, [cs + 8]: 1, [cs + 12]: 2,
    [stormBase + exportRva + 12]: nameRva,
    [queueHead]: nodeA,
    [nodeA + 4]: 0x3FC01000,
    [nodeA + 0x0C]: 0x280,
    [nodeA + 0x10]: 0x1234,
    [nodeA + 0x30]: nodeB,
    [nodeB + 4]: 0x3FC02000,
    [nodeB + 0x0C]: 0x280,
    [nodeB + 0x10]: 0x5678,
    [nodeB + 0x30]: nodeA,
  },
  bytes: {},
};
for (const [i, byte] of Array.from(Buffer.from('STORM.dll\0')).entries()) {
  stormState.bytes[stormBase + nameRva + i] = byte;
}
const stormWine = {
  running: true,
  memory: { buffer: dllMemory },
  instance: { exports: fakeExports(stormState) },
  threadManager: { threads: new Map() },
};
const stormSnapshot = collectSnapshot([{ wine: stormWine, name: 'diablo_demo', appIndex: 1 }]);
assert.strictEqual(stormSnapshot.apps[0].stormQueue.address, queueHead);
assert.strictEqual(stormSnapshot.apps[0].stormQueue.moduleBase, stormBase);
assert.strictEqual(stormSnapshot.apps[0].stormQueue.head, nodeA);
assert.strictEqual(stormSnapshot.apps[0].stormQueue.nodes.length, 2);
assert.strictEqual(stormSnapshot.apps[0].stormQueue.cycleAt, nodeA);
const stormText = formatSnapshot(stormSnapshot);
assert(stormText.includes('Storm active-list head 0x00654260 -> 0x3fc00cd0'));
assert(stormText.includes('CYCLE: 0x3fc00cd0 is reached again'));

let intervalMs = 0;
let popupFocused = false;
const output = { textContent: '' };
const popup = {
  closed: false,
  document: {
    title: '',
    body: { innerHTML: '' },
    getElementById: id => id === 'thread-state-output' ? output : null,
  },
  focus: () => { popupFocused = true; },
  close: () => { popup.closed = true; },
};
const viewer = createDebugThreadState({
  debugMode: true,
  getRunningApps: () => [{ wine, name: 'diablo_demo' }],
  openWindow: () => popup,
  setInterval: (_fn, ms) => { intervalMs = ms; return 1; },
  clearInterval: () => {},
});
assert.strictEqual(viewer.open(), popup);
assert.strictEqual(intervalMs, 500);
assert.strictEqual(popupFocused, true);
assert(output.textContent.includes('[diablo_demo]'));
assert(output.textContent.includes('0x07502a80'));

assert(index.includes('id="thread-state-btn" onclick="openThreadState()"'),
  'debug toolbar should expose the live thread-state popup');
assert(index.includes('threadStateViewer.beginLaunch(select && select.value)'),
  'launch should snapshot storage before app startup can mutate it');
assert(index.includes('lib/debug-thread-state.js?v=4'),
  'page should load the popup implementation with a cache key');
assert(index.includes('body.no-debug.exclusive-fullscreen #toolbar'),
  'only non-debug full-page mode should hide the toolbar');
assert(index.includes('body:not(.no-debug).exclusive-fullscreen #screen-wrap'),
  'debug full-page mode should remain bounded by the debug screen pane');
assert(!/body\.exclusive-fullscreen #toolbar,/.test(index),
  'an app fullscreen request must not hide the debug toolbar before browser fullscreen');

console.log('PASS  debug thread-state popup exposes deadlock ownership and bounds requested fullscreen');
