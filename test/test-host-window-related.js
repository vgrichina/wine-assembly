#!/usr/bin/env node

// Host-side renderer window relation regression. WAT's GetWindow handler uses
// the local WND table first, then falls back here when a related window lives
// only in renderer.windows, such as another app instance or JS-created dialog.

'use strict';

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');

const memory = new ArrayBuffer(64 * 1024);
const posted = [];
let clientRectComputes = 0;
const wasm = {
  exports: {
    post_message_q(hwnd, msg, wParam, lParam) {
      posted.push({ hwnd, msg, wParam, lParam });
    },
    wnd_window_screen_x() { throw new Error('get_window_rect re-entered WAT'); },
    wnd_window_screen_y() { throw new Error('get_window_rect re-entered WAT'); },
    wnd_screen_w() { throw new Error('get_window_rect re-entered WAT'); },
    wnd_screen_h() { throw new Error('get_window_rect re-entered WAT'); },
  },
};
const renderer = {
  _nextZ: 100,
  repaintScheduled: false,
  keyboardOwner: null,
  inputQueue: [
    { type: 'mouse', hwnd: 110, msg: 0x0202 },
    { type: 'paint', hwnd: 120, msg: 0x000F },
    { type: 'mouse', hwnd: 200, msg: 0x0200 },
    { type: 'key', hwnd: 0, msg: 0x0100 },
  ],
  _directMouseDown: { targetHwnd: 110 },
  _dialogBtnDrag: { parent: 100, target: 120 },
  _lastDeepChild: { topHwnd: 200, childHwnd: 210 },
  _computeClientRect() { clientRectComputes++; },
  _clampToolbarWidth() { return false; },
  scheduleRepaint() {
    this.repaintScheduled = true;
  },
  _setKeyboardInputOwner(win) {
    this.keyboardOwner = win;
  },
  windows: {
    100: { hwnd: 100, title: 'Tasks', className: 'MSTaskSwWClass', style: 0x10c00000, x: 10, y: 20, w: 300, h: 200, clientRect: { x: 13, y: 43, w: 294, h: 174 }, visible: true, enabled: true, isChild: false, zOrder: 10, processId: 4321, wasm },
    200: { hwnd: 200, style: 0x10c00000, visible: true, enabled: true, isChild: false, zOrder: 20, wasm },
    300: { hwnd: 300, style: 0x10c00000, visible: true, enabled: true, isChild: false, zOrder: 30, wasm },
    110: { hwnd: 110, style: 0x50000000, visible: true, enabled: true, isChild: true, parentHwnd: 100, zOrder: 11, wasm },
    120: { hwnd: 120, style: 0x50000000, visible: true, enabled: true, isChild: true, parentHwnd: 100, zOrder: 12, wasm },
    400: { hwnd: 400, style: 0x90000000, visible: true, enabled: true, isChild: false, ownerHwnd: 100, zOrder: 40, wasm },
    410: { hwnd: 410, style: 0x90000000, visible: false, enabled: true, isChild: false, ownerHwnd: 100, zOrder: 50, wasm },
    420: { hwnd: 420, style: 0x90000000, visible: true, enabled: false, isChild: false, ownerHwnd: 100, zOrder: 60, wasm },
    510: { hwnd: 510, x: 5, y: 7, w: 40, h: 30, clientRect: { x: 18, y: 50, w: 40, h: 30 }, parentHwnd: 100, isChild: true, zOrder: 1, wasm },
    520: { hwnd: 520, x: 2, y: 3, w: 10, h: 8, parentHwnd: 510, isChild: true, zOrder: 2, wasm },
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
assert.strictEqual(host.get_window_info(100, 3), 4321, 'get_window_info process owner');
assert.strictEqual(host.foreground_window(), 420,
  'foreground_window returns the highest visible renderer top-level');
renderer.windows[420].visible = false;
assert.strictEqual(host.foreground_window(), 400,
  'foreground_window skips hidden top-level windows');
renderer.windows[420].visible = true;
const topLevels = Object.values(renderer.windows).filter(win => !win.isChild);
const priorVisibility = topLevels.map(win => win.visible);
topLevels.forEach(win => { win.visible = false; });
assert.strictEqual(host.foreground_window(), 0,
  'foreground_window returns NULL while no top-level window is visible');
topLevels.forEach((win, index) => { win.visible = priorVisibility[index]; });

const computesBeforeRect = clientRectComputes;
host.get_window_rect(510, 128);
assert.strictEqual(clientRectComputes, computesBeforeRect,
  'GetWindowRect must not re-enter WAT through client-rect recomputation');
const childRect = new DataView(memory, 128, 16);
assert.deepStrictEqual(Array.from({ length: 4 }, (_, i) => childRect.getInt32(i * 4, true)),
  [18, 50, 58, 80], 'GetWindowRect resolves child coordinates without re-entering WAT');
host.get_window_rect(520, 144);
const nestedRect = new DataView(memory, 144, 16);
assert.deepStrictEqual(Array.from({ length: 4 }, (_, i) => nestedRect.getInt32(i * 4, true)),
  [20, 53, 30, 61], 'nested child uses its immediate absolute client origin exactly once');

let reentries = 0;
wasm.exports.wnd_window_screen_x = hwnd => {
  reentries++;
  host.get_window_rect(hwnd, 160);
  return 101;
};
wasm.exports.wnd_window_screen_y = () => 202;
wasm.exports.wnd_screen_w = () => 40;
wasm.exports.wnd_screen_h = () => 30;
host.get_window_rect(510, 176);
const reentrantFallback = new DataView(memory, 160, 16);
assert.deepStrictEqual(Array.from({ length: 4 }, (_, i) => reentrantFallback.getInt32(i * 4, true)),
  [18, 50, 58, 80], 'a nested rectangle query uses the bounded renderer fallback');
const authoritativeRect = new DataView(memory, 176, 16);
assert.deepStrictEqual(Array.from({ length: 4 }, (_, i) => authoritativeRect.getInt32(i * 4, true)),
  [101, 202, 141, 232], 'outer child query keeps authoritative guest coordinates');
assert.strictEqual(reentries, 1, 'guest rectangle lookup cannot recursively re-enter itself');

host.set_parent(100, 510);
assert.strictEqual(renderer.windows[100].parentHwnd, undefined,
  'renderer parenting rejects an edge that would create a cycle');

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
assert.strictEqual(renderer.keyboardOwner, renderer.windows[100],
  'activate_window assigns keyboard input to the activated top-level');
assert.strictEqual(host.foreground_window(), 100,
  'activating a window makes it the renderer-wide foreground window');

const topZBeforeChildActivation = renderer.windows[100].zOrder;
host.set_window_zorder(110, 0);
assert(renderer.windows[110].zOrder > renderer.windows[120].zOrder,
  'HWND_TOP raises a child above its siblings without disturbing other groups');
assert.strictEqual(host.activate_window(110), 1, 'activate_window accepts a child HWND');
assert(renderer.windows[100].zOrder > topZBeforeChildActivation,
  'activating a child raises its associated top-level window');
assert.strictEqual(renderer.keyboardOwner, renderer.windows[100],
  'activating a child assigns keyboard input to its top-level ancestor');
assert.strictEqual(host.activate_window(0x7ffffffe), 0,
  'activate_window rejects an unknown HWND');

const activatedZ = renderer.windows[100].zOrder;
host.move_window(300, 0, 0, 0, 0, 0x43); // SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW
assert.strictEqual(renderer.windows[300].zOrder, 30,
  'SWP_SHOWWINDOW does not re-raise an already-visible normal window');
renderer.windows[300].visible = false;
host.move_window(300, 0, 0, 0, 0, 0x43);
assert(renderer.windows[300].zOrder > activatedZ,
  'SWP_SHOWWINDOW raises a normal window when it becomes visible');

const inputQueueIdentity = renderer.inputQueue;
host.destroy_window(100);
assert.strictEqual(renderer.inputQueue, inputQueueIdentity,
  'DestroyWindow compacts the browser input queue in place');
assert.deepStrictEqual(renderer.inputQueue.map(event => [event.hwnd, event.msg]), [
  [200, 0x0200],
  [0, 0x0100],
], 'DestroyWindow purges queued input for the window and its children only');
assert.strictEqual(renderer._directMouseDown, null,
  'DestroyWindow clears a deferred mouse release aimed at a destroyed child');
assert.strictEqual(renderer._dialogBtnDrag, null,
  'DestroyWindow clears dialog-button capture aimed at the destroyed tree');
assert.deepStrictEqual(renderer._lastDeepChild, { topHwnd: 200, childHwnd: 210 },
  'DestroyWindow preserves transient input state for an unrelated window');
assert(!renderer.windows[100] && !renderer.windows[110] && !renderer.windows[120],
  'DestroyWindow removes the renderer window tree');
assert(renderer.windows[200], 'DestroyWindow preserves unrelated renderer windows');

console.log('PASS  host renderer window relations cover GetWindow fallback helpers');
