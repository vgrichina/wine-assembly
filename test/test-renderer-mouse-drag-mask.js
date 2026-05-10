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

console.log('PASS  renderer mouse drag moves carry button state');
