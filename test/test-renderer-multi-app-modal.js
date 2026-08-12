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

const appA = {
  exports: {
    modal_dialog_hwnd() { return 101; },
    wnd_window_screen_x(hwnd) { return hwnd === 101 ? 350 : 300; },
    wnd_window_screen_y() { return 20; },
    wnd_screen_w(hwnd) { return hwnd === 101 ? 100 : 250; },
    wnd_screen_h(hwnd) { return hwnd === 101 ? 100 : 180; },
  },
};
const appB = {
  exports: {
    modal_dialog_hwnd() { return 0; },
    wnd_child_from_point_deep() { return 0; },
    set_focus_hwnd() {},
  },
};

const renderer = new Win98Renderer(canvas);
renderer.wasm = appA;
renderer.windows[100] = {
  hwnd: 100, visible: true, isChild: false,
  x: 300, y: 10, w: 250, h: 200, zOrder: 1, style: 0, wasm: appA,
};
renderer.windows[101] = {
  hwnd: 101, visible: true, isChild: false, isDialog: true, isAboutDialog: true,
  x: 30, y: 20, w: 100, h: 100, zOrder: 2, style: 0, wasm: appA,
};
renderer.windows[200] = {
  hwnd: 200, visible: true, isChild: false,
  x: 10, y: 10, w: 250, h: 200, zOrder: 3, style: 0, wasm: appB,
};
renderer._nextZ = 4;

renderer.handleMouseDown(40, 60, 0);
renderer.handleMouseUp(40, 60, 0);
assert.deepStrictEqual(renderer.inputQueue.map(event => [event.hwnd, event.msg]), [
  [200, 0x0201],
  [200, 0x0202],
], 'a dialog in app A must not outrank the frontmost overlapping window in app B');

renderer.inputQueue.length = 0;
renderer.windows[100].zOrder = renderer._nextZ++;
renderer.handleMouseDown(310, 180, 0);
renderer.handleMouseUp(310, 180, 0);
assert.deepStrictEqual(renderer.inputQueue, [], 'app A modal dialog should still block its own owner window');

console.log('PASS  multi-app modal input blocking stays within the owning emulator instance');
