#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { createCanvas } = require('../lib/canvas-compat');
const { Win98Renderer } = require('../lib/renderer');
// $DI_MOUSE_INPUT_STATE, from the map declared in src/00-regions.wat.
const RegionMap = require('../lib/region-map.generated.js');

const renderer = new Win98Renderer(createCanvas(1280, 960));
const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
const guestExports = {
  clip_cursor_active: () => 1,
  clip_cursor_left: () => 100,
  clip_cursor_top: () => 50,
  clip_cursor_right: () => 740,
  clip_cursor_bottom: () => 530,
  wnd_mouse_msg_origin_x: () => 100,
  wnd_mouse_msg_origin_y: () => 50,
  post_message_q: () => 1,
};
const wasm = { exports: guestExports };
renderer.wasm = wasm;
renderer.wasmMemory = memory;
renderer.windows[7] = {
  hwnd: 7, visible: true, isChild: false, x: 100, y: 50, w: 640, h: 480,
  clientRect: { x: 100, y: 50, w: 640, h: 480 }, zOrder: 1, wasm,
  wasmMemory: memory,
};
renderer._exclusiveTransform = {
  hwnd: 7,
  srcX: 100, srcY: 50, srcW: 640, srcH: 480,
  dstX: 0, dstY: 0, dstW: 1280, dstH: 960,
};

renderer.setMousePosition(420, 50);
renderer.handleRelativeMouseMove(0, -40);
renderer.handleRelativeMouseMove(0, -40);

assert.deepStrictEqual([renderer._mouseX, renderer._mouseY], [420, 50],
  'the virtual Win32 cursor remains confined to the guest ClipCursor edge');
const words = new Int32Array(memory.buffer);
const state = RegionMap.BASE.DI_MOUSE_INPUT_STATE >>> 2;
assert.deepStrictEqual([words[state], words[state + 1]], [0, -40],
  'DirectInput preserves both complete scaled deltas after the cursor reaches the edge');

const moves = renderer.inputQueue.filter(event => event && event.msg === 0x0200);
assert(moves.length >= 1, 'relative movement still produces an ordinary WM_MOUSEMOVE');
assert.strictEqual(moves[moves.length - 1].lParam >>> 0, 320,
  'the coalesced WM_MOUSEMOVE retains clipped client coordinates');

// Browser sharp/FSR presentation can have a physical viewport whose scale is
// different from the hidden logical staging transform. Preserve sub-pixel
// native motion across events and use that viewport's scale for DirectInput.
words[state] = 0;
words[state + 1] = 0;
renderer._relativeMouseRemainderX = 0;
renderer._relativeMouseRemainderY = 0;
renderer._exclusivePresentationViewport = {
  nativeX: 100, nativeY: 50, nativeW: 640, nativeH: 480,
  dstX: 240, dstY: 0, dstW: 1440, dstH: 1080,
  outputW: 1920, outputH: 1080,
};
renderer.setMousePosition(420, 50);
renderer.handleRelativeMouseMove(0, -1);
renderer.handleRelativeMouseMove(0, -1);
assert.deepStrictEqual([renderer._mouseX, renderer._mouseY], [420, 50],
  'presentation-scaled relative motion keeps the Win32 cursor clipped');
assert.deepStrictEqual([words[state], words[state + 1]], [0, -1],
  'two half-native-pixel moves accumulate into one unbounded DirectInput delta');

console.log('PASS  ClipCursor does not truncate unbounded DirectInput mouse deltas');
