#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { Win98Renderer } = require('../lib/renderer');

const canvas = {
  width: 640,
  height: 480,
  getContext() {
    return {
      save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      clearRect() {}, fillRect() {}, strokeRect() {}, fillText() {},
      measureText() { return { width: 0 }; },
      drawImage() {}, putImageData() {}, getImageData() { return { data: new Uint8ClampedArray(4) }; },
    };
  },
};

const notifications = [];
const memory = new WebAssembly.Memory({ initial: 1 });
const title = 0x100;
new TextEncoder().encodeInto('Volume Control\0', new Uint8Array(memory.buffer, title));
const wasm = {
  exports: {
    dlg_get_style() { return 0x80c80000; },
    dlg_get_x() { return 10; },
    dlg_get_y() { return 10; },
    dlg_get_cx() { return 160; },
    dlg_get_cy() { return 120; },
    dlg_get_title_wa() { return title; },
    dlg_get_menu() { return 0; },
    notify_shell_window(code, hwnd) {
      notifications.push({ code, hwnd });
      return 1;
    },
    nc_post_paint() {},
  },
};

const renderer = new Win98Renderer(canvas);
renderer.wasm = wasm;
renderer.wasmMemory = memory;
renderer.createDialog(100, 50, wasm, memory);
assert.deepStrictEqual(notifications, [], 'hidden top-level dialog should not announce a task');

renderer.showWindow(100, 5);
assert.deepStrictEqual(notifications, [{ code: 1, hwnd: 100 }],
  'showing a top-level dialog should announce the user-facing task window');

renderer.showWindow(100, 5);
assert.strictEqual(notifications.length, 1, 'showing an already visible dialog should not duplicate shell creation');

renderer.showWindow(100, 6);
assert.strictEqual(renderer.windows[100].visible, false, 'SW_MINIMIZE should hide the task window');
assert.strictEqual(renderer.windows[100]._minimized, true, 'SW_MINIMIZE should preserve minimized state');

renderer.showWindow(100, 5);
assert.strictEqual(renderer.windows[100].visible, true, 'SW_SHOW should restore the task window');
assert.strictEqual(renderer.windows[100]._minimized, false, 'SW_SHOW should clear minimized state');

console.log('PASS  renderer announces dialog-only apps and preserves ShowWindow task state');
