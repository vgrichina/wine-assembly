#!/usr/bin/env node
'use strict';

// A game that hides/clips its cursor from inside the frame loop can publish
// that state a frame after the click that should have captured the mouse.
// The bridge latches the renderer heuristic per exclusive presentation, so a
// click whose sampled state loses that race still requests Pointer Lock —
// without any relativeMouse manifest declaration.

const assert = require('assert');

const listeners = new Map();
const addListener = (type, fn) => listeners.set(type, fn);
const lockRequests = [];
const canvas = {
  width: 640,
  height: 480,
  style: {},
  classList: { toggle() {} },
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
  addEventListener: addListener,
  removeEventListener() {},
  setAttribute() {},
  focus() {},
  webkitRequestPointerLock() {
    lockRequests.push(1);
  },
};

global.window = {
  addEventListener: addListener,
  removeEventListener() {},
  MobileKeyboard: null,
};
global.document = {
  pointerLockElement: null,
  webkitPointerLockElement: null,
  body: {},
  documentElement: {},
  activeElement: canvas,
  visibilityState: 'visible',
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener: addListener,
  elementFromPoint: () => null,
};

const intervalFns = [];
const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
global.setInterval = fn => { intervalFns.push(fn); return intervalFns.length; };
global.clearInterval = () => {};

const calls = { absolute: [] };
let heuristic = false;
// Deliberately no relativeMouse manifest flag: the latch alone must decide.
const runningApps = [{ name: 'mw3_demo', wine: { running: true } }];
const renderer = {
  windows: {},
  _exclusiveTransform: { hwnd: 1 },
  wantsRelativeMouse: () => heuristic,
  wantsHiddenMouse: () => false,
  handleMouseMove: (x, y) => calls.absolute.push([x, y]),
  handleRelativeMouseMove() {},
  handleMenuHover() {},
  handleMouseDown() {},
  handleMouseUp() {},
  handleWheel() {},
};

function click(x, y) {
  canvas.onmousedown({
    clientX: x, clientY: y, button: 0, buttons: 1,
    ctrlKey: false, shiftKey: false, preventDefault() {},
  });
  listeners.get('mouseup')({
    clientX: x, clientY: y, button: 0,
    preventDefault() {}, stopPropagation() {},
  });
}

try {
  const browserInput = require('../lib/browser-input');
  browserInput.wireCanvasInput(canvas, renderer, { runningApps, debugMode: false });

  click(320, 240);
  assert.strictEqual(lockRequests.length, 0,
    'no guest cursor state and no manifest flag must not capture');

  heuristic = true;
  canvas.onmousemove({ clientX: 300, clientY: 200, movementX: 1, movementY: 0 });
  assert.deepStrictEqual(calls.absolute, [],
    'a relative-mouse guest must not receive the arming hover as absolute motion');

  heuristic = false;
  click(320, 240);
  assert.strictEqual(lockRequests.length, 1,
    'a click that loses the state race must still capture once the latch armed');

  renderer._exclusiveTransform = null;
  canvas.onmousemove({ clientX: 123, clientY: 234, movementX: 1, movementY: 0 });
  assert.deepStrictEqual(calls.absolute, [[123, 234]],
    'the latch must drop with the exclusive presentation');
  click(123, 234);
  assert.strictEqual(lockRequests.length, 1,
    'a windowed guest must not inherit a stale latch');

  renderer._exclusiveTransform = { hwnd: 1 };
  heuristic = true;
  for (const fn of intervalFns) fn();
  heuristic = false;
  click(320, 240);
  assert.strictEqual(lockRequests.length, 2,
    'the stationary-pointer poll must arm the latch between input events');
} finally {
  global.setInterval = realSetInterval;
  global.clearInterval = realClearInterval;
}

console.log('PASS  relative-mouse latch survives the guest cursor-state race');
