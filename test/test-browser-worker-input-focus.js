#!/usr/bin/env node
'use strict';

// Browser Worker mode keeps the live guest main thread in slot 0. Its focus
// global is not shared with the idle local WASM instance, so keyboard events
// must route through focus published by the Worker rather than local exports.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { installInputHandlers } = require('../lib/renderer-input');
const { Win98Renderer } = require('../lib/renderer');

const root = path.join(__dirname, '..');
const host = fs.readFileSync(path.join(root, 'host.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'lib', 'guest-worker.js'), 'utf8');
const input = fs.readFileSync(path.join(root, 'lib', 'renderer-input.js'), 'utf8');

assert(worker.includes('focusHwnd: ex.get_focus_hwnd ? ex.get_focus_hwnd() >>> 0 : 0'),
  'guest Worker slice result should publish its live focus hwnd');
assert(host.includes('self._workerFocusHwnd = r.focusHwnd | 0;'),
  'browser Worker loop should cache the focus returned by slot 0');
assert(host.includes("evt.type === 'mouse' && evt.msg === 0x0201 && evt.hwnd"),
  'dequeued mouse-down should update Worker focus before rapid following keys');
assert(/const routingExports = self\.guestWorker[\s\S]*?get_focus_hwnd: \(\) => self\._workerFocusHwnd \| 0[\s\S]*?inputEventHwnd\(evt, routingExports\)/.test(host),
  'browser keyboard routing should consult cached Worker focus, not idle local focus');
assert(host.includes('this.renderer._guestWorkerWasms.add(this.instance);'),
  'Worker-backed renderer ownership token should be marked');
assert(input.includes('if (this._keyboardOwnerRunsInGuestWorker())'),
  'Worker-backed keyboard events should bypass direct calls into the idle instance');
assert(host.includes("workerUrl: 'lib/guest-worker.js?v=13'"),
  'guest Worker cache key should change with its slice result protocol');

class RendererProbe {
  constructor(wasm) {
    this.inputQueue = [];
    this.windows = {};
    this.wasm = wasm;
    this.mainWasm = wasm;
    this._exited = false;
    this._guestWorkerWasms = new WeakSet([wasm]);
  }
}
installInputHandlers(RendererProbe);

let directMessages = 0;
const idleWasm = {
  exports: {
    get_focus_hwnd: () => 0x10013,
    ctrl_get_class: () => 2,
    send_message: () => { directMessages++; },
  },
};
const renderer = new RendererProbe(idleWasm);
renderer.handleKeyDown(0x43, { code: 'KeyC' });
renderer.handleKeyPress(0x43);

assert.strictEqual(directMessages, 0,
  'Worker-backed keyboard handling must not execute the idle instance');
assert.deepStrictEqual(renderer.inputQueue.map(event => [event.msg, event.wParam]), [
  [0x0100, 0x43],
  [0x0102, 0x43],
], 'Worker-backed keydown and character messages should stay ordered in the guest queue');

// Mouse focus used to have only the keyboard half of the Worker guard. A
// Win16 menu click first called set_focus on the idle browser instance, which
// entered an x86 wndproc with slot 0's EIP/selectors absent and trapped before
// menu_handle_bar_click could run.
const canvas = {
  getContext() {
    return {
      save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      clearRect() {}, fillRect() {}, strokeRect() {}, fillText() {},
      measureText() { return { width: 0 }; },
      drawImage() {}, putImageData() {},
      getImageData() { return { data: new Uint8ClampedArray(4) }; },
    };
  },
};
const menuRenderer = new Win98Renderer(canvas);
let shadowFocus = 0;
let liveFocusCalls = 0;
let menuClicks = 0;
const workerOwnedWasm = {
  exports: {
    get_focus_hwnd: () => shadowFocus,
    set_focus() {
      liveFocusCalls++;
      throw new WebAssembly.RuntimeError('idle Worker ownership token executed');
    },
    set_focus_hwnd(hwnd) { shadowFocus = hwnd | 0; },
    menu_handle_bar_click() { menuClicks++; return 1; },
  },
};
menuRenderer.wasm = workerOwnedWasm;
menuRenderer.mainWasm = workerOwnedWasm;
menuRenderer._guestWorkerWasms = new WeakSet([workerOwnedWasm]);
menuRenderer._ensureWatMenu = () => {};
menuRenderer.windows[0x10002] = {
  hwnd: 0x10002, visible: true, isChild: false,
  x: 10, y: 10, w: 300, h: 220, style: 0, zOrder: 1,
  hasCaption: false, _menuId: 1, wasm: workerOwnedWasm,
};
menuRenderer.handleMouseDown(40, 30, 0);
assert.strictEqual(liveFocusCalls, 0,
  'Worker-backed mouse focus must not execute the idle browser WASM instance');
assert.strictEqual(shadowFocus, 0x10002,
  'renderer shadow focus should still follow the clicked Worker-owned window');
assert.strictEqual(menuClicks, 1,
  'Worker-backed Win16 menu click should reach the menu tracker after focus routing');

console.log('PASS browser Worker keyboard and menu input avoid the idle WASM instance');
