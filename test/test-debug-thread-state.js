#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createDebugThreadState,
  collectSnapshot,
  formatSnapshot,
} = require('../lib/debug-thread-state');

const ROOT = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function fakeExports(state) {
  return {
    get_current_thread_id: () => state.tid,
    get_eip: () => state.eip,
    get_esp: () => state.esp,
    get_yield_reason: () => state.yield,
    get_wait_handle: () => state.wait || 0,
    guest_read32: address => state.memory[address >>> 0] || 0,
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
  address: cs, lock: 0, recursion: 1, owner: 2,
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
assert(index.includes('lib/debug-thread-state.js?v=2'),
  'page should load the popup implementation with a cache key');
assert(index.includes('body.no-debug.exclusive-fullscreen #toolbar'),
  'only non-debug full-page mode should hide the toolbar');
assert(index.includes('body:not(.no-debug).exclusive-fullscreen #screen-wrap'),
  'debug full-page mode should remain bounded by the debug screen pane');
assert(!/body\.exclusive-fullscreen #toolbar,/.test(index),
  'an app fullscreen request must not hide the debug toolbar before browser fullscreen');

console.log('PASS  debug thread-state popup exposes deadlock ownership and bounds requested fullscreen');
