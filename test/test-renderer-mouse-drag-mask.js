#!/usr/bin/env node
// Renderer input should preserve Win32 mouse-button state on WM_MOUSEMOVE.
// Games commonly start drags from WM_MOUSEMOVE + MK_LBUTTON; if the browser
// captures the drag before the guest calls SetCapture, the move still needs
// the current button mask.

const assert = require('assert');
const { Win98Renderer } = require('../lib/renderer');

const canvas = {
  getContext() {
    return {
      save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      clearRect() {}, fillRect() {}, strokeRect() {}, fillText() {},
      measureText() { return { width: 0 }; },
      drawImage() {}, putImageData() {}, getImageData() { return { data: new Uint8ClampedArray(4) }; },
    };
  },
};

const r = new Win98Renderer(canvas);
r.windows[100] = {
  hwnd: 100,
  visible: true,
  isChild: false,
  x: 10,
  y: 10,
  w: 200,
  h: 160,
  hasCaption: false,
  style: 0,
  zOrder: 1,
};

r.handleMouseDown(40, 60, 1);
r.handleMouseMove(80, 90);

let move = r.inputQueue.find(e => e.msg === 0x0200);
assert(move, 'drag should enqueue WM_MOUSEMOVE');
assert.strictEqual(move.wParam & 0x0001, 0x0001, 'drag move should include MK_LBUTTON');

r.handleMouseUp(80, 90, 1);
r.inputQueue.length = 0;
r.handleMouseMove(90, 100);

move = r.inputQueue.find(e => e.msg === 0x0200);
assert(move, 'hover should enqueue WM_MOUSEMOVE');
assert.strictEqual(move.wParam & 0x0001, 0, 'hover move after mouseup should not include MK_LBUTTON');

const captionRenderer = new Win98Renderer(canvas);
const captionWasm = {
  exports: {
    hittest_sync() { return 2; }, // HTCAPTION
  },
};
captionRenderer.wasm = captionWasm;
captionRenderer.windows[200] = {
  hwnd: 200,
  visible: true,
  isChild: false,
  x: 20,
  y: 20,
  w: 160,
  h: 90,
  hasCaption: true,
  style: 0x00c00000,
  zOrder: 1,
  wasm: captionWasm,
};
captionRenderer.handleMouseDown(35, 28, 1);
assert(captionRenderer._draggingWin, 'normal caption click should start renderer window drag');
assert.strictEqual(captionRenderer.inputQueue.length, 0, 'normal caption drag should not leak app mouse down');

const shapedRenderer = new Win98Renderer(canvas);
const shapedWasm = {
  exports: {
    hittest_sync() { return 2; }, // would be HTCAPTION for normal windows
  },
};
shapedRenderer.wasm = shapedWasm;
shapedRenderer.windows[300] = {
  hwnd: 300,
  visible: true,
  isChild: false,
  x: 20,
  y: 20,
  w: 160,
  h: 90,
  region: { rects: [{ x: 0, y: 0, w: 160, h: 90 }] },
  hasCaption: true,
  style: 0x00c00000,
  zOrder: 1,
  wasm: shapedWasm,
};
shapedRenderer.handleMouseDown(35, 28, 1);
assert(!shapedRenderer._draggingWin, 'app-drawn shaped caption should not start renderer window drag');
const shapedDown = shapedRenderer.inputQueue.find(e => e.msg === 0x0201);
assert(shapedDown, 'app-drawn shaped caption should receive WM_LBUTTONDOWN');
assert.strictEqual(shapedDown.hwnd, 300);
assert.strictEqual(shapedDown.lParam, ((8 & 0xFFFF) << 16) | (15 & 0xFFFF), 'shaped caption lParam should be window-relative');

const clippedRenderer = new Win98Renderer(canvas);
const clippedWasm = {
  exports: {
    clip_cursor_active() { return 1; },
    clip_cursor_left() { return 50; },
    clip_cursor_top() { return 70; },
    clip_cursor_right() { return 60; },
    clip_cursor_bottom() { return 80; },
    wnd_mouse_msg_origin_x() { return 0; },
    wnd_mouse_msg_origin_y() { return 0; },
  },
};
clippedRenderer.wasm = clippedWasm;
clippedRenderer.windows[400] = {
  hwnd: 400,
  visible: true,
  isChild: false,
  x: 0,
  y: 0,
  w: 200,
  h: 200,
  style: 0,
  zOrder: 1,
  wasm: clippedWasm,
};
clippedRenderer.handleMouseDown(40, 60, 1);
clippedRenderer.handleMouseMove(80, 90);
clippedRenderer.handleMouseUp(80, 90, 1);
const clippedDown = clippedRenderer.inputQueue.find(e => e.msg === 0x0201);
const clippedMove = clippedRenderer.inputQueue.find(e => e.msg === 0x0200);
const clippedUp = clippedRenderer.inputQueue.find(e => e.msg === 0x0202);
assert.strictEqual(clippedDown.lParam, (70 << 16) | 50, 'ClipCursor should clamp mousedown to left/top edge');
assert.strictEqual(clippedMove.lParam, (57 << 16) | 56, 'ClipCursor should clamp normal mousemove before client offset');
assert.strictEqual(clippedUp.lParam, (79 << 16) | 59, 'ClipCursor should clamp mouseup to right/bottom edge');

console.log('PASS  renderer mouse drag moves carry button state');
