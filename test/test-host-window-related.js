#!/usr/bin/env node

// Host-side renderer window relation regression. WAT's GetWindow handler uses
// the local WND table first, then falls back here when a related window lives
// only in renderer.windows, such as another app instance or JS-created dialog.

'use strict';

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');

const memory = new ArrayBuffer(64 * 1024);
const posted = [];
const wasm = {
  exports: {
    post_message_q(hwnd, msg, wParam, lParam) {
      posted.push({ hwnd, msg, wParam, lParam });
    },
  },
};
const renderer = {
  _nextZ: 100,
  repaintScheduled: false,
  scheduleRepaint() {
    this.repaintScheduled = true;
  },
  windows: {
    100: { hwnd: 100, title: 'Tasks', className: 'MSTaskSwWClass', style: 0x10c00000, visible: true, enabled: true, isChild: false, zOrder: 10, wasm },
    200: { hwnd: 200, style: 0x10c00000, visible: true, enabled: true, isChild: false, zOrder: 20, wasm },
    300: { hwnd: 300, style: 0x10c00000, visible: true, enabled: true, isChild: false, zOrder: 30, wasm },
    110: { hwnd: 110, style: 0x50000000, visible: true, enabled: true, isChild: true, parentHwnd: 100, zOrder: 11, wasm },
    120: { hwnd: 120, style: 0x50000000, visible: true, enabled: true, isChild: true, parentHwnd: 100, zOrder: 12, wasm },
    400: { hwnd: 400, style: 0x90000000, visible: true, enabled: true, isChild: false, ownerHwnd: 100, zOrder: 40, wasm },
    410: { hwnd: 410, style: 0x90000000, visible: false, enabled: true, isChild: false, ownerHwnd: 100, zOrder: 50, wasm },
    420: { hwnd: 420, style: 0x90000000, visible: true, enabled: false, isChild: false, ownerHwnd: 100, zOrder: 60, wasm },
  },
};

const { host } = createHostImports({
  getMemory: () => memory,
  renderer,
  exports: wasm.exports,
});

// Same top-level sibling group, highest z-order first.
assert.strictEqual(host.get_window_related(200, 0), 420, 'GW_HWNDFIRST uses top z-order sibling');
assert.strictEqual(host.get_window_related(200, 1), 100, 'GW_HWNDLAST uses bottom z-order sibling');
assert.strictEqual(host.get_window_related(300, 2), 200, 'GW_HWNDNEXT returns next lower z-order sibling');
assert.strictEqual(host.get_window_related(200, 3), 300, 'GW_HWNDPREV returns next higher z-order sibling');
assert.strictEqual(host.get_window_related(0x10000, 5), 420, 'desktop GW_CHILD starts renderer top-level walk');

// Child relation walks only the requested parent child group.
assert.strictEqual(host.get_window_related(100, 5), 120, 'GW_CHILD returns top z-order child');
assert.strictEqual(host.get_window_related(110, 0), 120, 'child GW_HWNDFIRST stays inside same parent');
assert.strictEqual(host.get_window_related(120, 2), 110, 'child GW_HWNDNEXT stays inside same parent');
assert.strictEqual(host.get_window_related(110, 3), 120, 'child GW_HWNDPREV stays inside same parent');

// Owner and enabled popup coverage.
assert.strictEqual(host.get_window_related(400, 4), 100, 'GW_OWNER returns renderer ownerHwnd');
assert.strictEqual(host.get_window_related(100, 6), 400, 'GW_ENABLEDPOPUP skips hidden/disabled owned popups');
assert.strictEqual(host.get_window_related(300, 6), 300, 'GW_ENABLEDPOPUP returns hwnd when no popup exists');

// Imported utility helpers are callable and reflect renderer state.
assert.strictEqual(host.get_window_info(100, 0), 0x10c00000, 'get_window_info style');
assert.strictEqual(host.get_window_info(410, 1), 0, 'get_window_info visible');
assert.strictEqual(host.get_window_info(420, 2), 0, 'get_window_info enabled');

assert.strictEqual(host.get_window_text_length(100), 5, 'foreign renderer title length');
assert.strictEqual(host.get_window_text(100, 32, 16), 5, 'foreign renderer title copy');
assert.strictEqual(Buffer.from(memory, 32, 5).toString('latin1'), 'Tasks', 'foreign renderer title bytes');
assert.strictEqual(host.get_window_class(100, 64, 32), 14, 'foreign renderer class copy');
assert.strictEqual(Buffer.from(memory, 64, 14).toString('latin1'), 'MSTaskSwWClass', 'foreign renderer class bytes');

assert.strictEqual(host.post_window_message(100, 0x0111, 123, 456), 1, 'post_window_message queues through owner wasm');
assert.deepStrictEqual(posted.pop(), { hwnd: 100, msg: 0x0111, wParam: 123, lParam: 456 });

assert.strictEqual(host.activate_window(100), 1, 'activate_window succeeds');
assert(renderer.windows[100].zOrder >= 100, 'activate_window raises z-order');
assert(renderer.repaintScheduled, 'activate_window schedules repaint');

console.log('PASS  host renderer window relations cover GetWindow fallback helpers');
